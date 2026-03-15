const { enviarMensaje, crearCanal } = require('../lib/slack');
const { registrarNotificacion } = require('../lib/notion');

const NOTION_API = 'https://api.notion.com/v1';
const SLACK_HABIB = process.env.SLACK_HABIB_CHANNEL || 'C0A5NEJ0QHL';

const getHeaders = () => ({
  'Authorization': `Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
});

const DB = {
  CLINICAS:  'bfbaf930-3746-42e7-b52c-6a819cd9264f',
  COBRANZA:  '76bcf3a2-71c8-456a-bcd8-a9de22d30447',
  CANALES:   '74578322-6cb5-463d-b0fb-3084c43b2e6c',
  COLA:      '74f55166-e5bc-4c10-bea3-bdfb1cf7f74f'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clinica, doctor, telefono, ciudad, monto, fechaCobro, ambiente } = req.body;

  if (!clinica || !doctor) {
    return res.status(400).json({ error: 'Faltan campos: clinica y doctor son requeridos' });
  }

  const esProduccion = ambiente === 'Produccion' || ambiente === 'Producción';
  const prefijo = esProduccion ? 'soporte' : 'test';
  const nombreCanal = `${prefijo}_${clinica.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60)}`;
  const log = [];

  try {
    // 1. Crear canal de Slack
    const slackResult = await crearCanal(nombreCanal);
    const slackChannelId = slackResult?.channel?.id || null;
    const slackChannelName = slackResult?.channel?.name || nombreCanal;
    log.push({ paso: 'Slack canal', ok: !!slackChannelId, id: slackChannelId, nombre: slackChannelName });

    // 2. Dar de alta en Clínicas (Notion)
    const clinicaPage = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({
        parent: { database_id: DB.CLINICAS },
        properties: {
          'Clínica':         { title: [{ text: { content: clinica } }] },
          'Doctor / Contacto': { rich_text: [{ text: { content: doctor } }] },
          'Ciudad':          { rich_text: [{ text: { content: ciudad || '' } }] },
          'Teléfono':        { phone_number: telefono || null },
          'Precio Mensual':  { number: monto || 0 },
          'Status':          { select: { name: esProduccion ? 'En Onboarding' : 'Prospecto' } },
          'Paquete':         { select: { name: 'Estándar' } },
          'date:Fecha Alta:start': new Date().toISOString().split('T')[0],
          'date:Fecha Alta:is_datetime': 0
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Clinicas Notion', ok: !!clinicaPage.id, id: clinicaPage.id });

    // 3. Dar de alta en Cobranza (Notion)
    const hoy = new Date();
    const fechaCobro1 = fechaCobro || new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1).toISOString().split('T')[0];
    const cobranzaPage = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({
        parent: { database_id: DB.COBRANZA },
        properties: {
          'Concepto':       { title: [{ text: { content: `Mensualidad ${clinica} — ${new Date().toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })}` } }] },
          'Monto':          { number: monto || 3000 },
          'Status Pago':    { status: { name: 'Pendiente' } },
          'date:Fecha de Cobro:start': fechaCobro1,
          'date:Fecha de Cobro:is_datetime': 0,
          'Notas':          { rich_text: [{ text: { content: `Onboarding automatico. Doctor: ${doctor}. Ciudad: ${ciudad || 'N/A'}` } }] }
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Cobranza Notion', ok: !!cobranzaPage.id, id: cobranzaPage.id });

    // 4. Registrar canal en Canales de Comunicación (Notion)
    const canalPage = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({
        parent: { database_id: DB.CANALES },
        properties: {
          'Clínica':           { title: [{ text: { content: clinica } }] },
          'Canal Slack Testing': { rich_text: [{ text: { content: `#${slackChannelName}` } }] },
          'WhatsApp Grupo ID': { rich_text: [{ text: { content: slackChannelId || '' } }] },
          'Ambiente':          { select: { name: esProduccion ? 'Producción' : 'Testing' } },
          'Activo':            { checkbox: true },
          'Notas':             { rich_text: [{ text: { content: `Creado automaticamente en onboarding. Slack ID: ${slackChannelId}` } }] }
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Canales Notion', ok: !!canalPage.id, id: canalPage.id });

    // 5. Registrar en Cola de Notificaciones
    await registrarNotificacion({
      clinica, tipo: 'Bienvenida',
      agente: 'Sistema', canal: 'Slack Testing',
      ambiente: esProduccion ? 'Producción' : 'Testing',
      mensaje: `Onboarding completado para ${clinica}. Canal: #${slackChannelName}. Doctor: ${doctor}.`
    });
    log.push({ paso: 'Cola Notificaciones', ok: true });

    // 6. Mensaje interno al equipo en Slack
    const msgEquipo = `*Nuevo cliente onboarding* ✅\n*Clínica:* ${clinica}\n*Doctor:* ${doctor}\n*Ciudad:* ${ciudad || 'N/A'}\n*Mensualidad:* $${(monto || 3000).toLocaleString('es-MX')} MXN\n*Canal:* #${slackChannelName}\n*Ambiente:* ${esProduccion ? 'Producción' : 'Testing'}\n_Todo configurado automáticamente en Notion_`;
    await enviarMensaje(SLACK_HABIB, msgEquipo);
    log.push({ paso: 'Mensaje equipo Slack', ok: true });

    // 7. Mensaje de bienvenida en el canal del cliente (solo en produccion)
    if (esProduccion && slackChannelId) {
      await enviarMensaje(slackChannelId, `Bienvenido a Dental Growth, ${doctor}. Este es tu canal directo con nuestro equipo. Por aquí recibirás reportes, actualizaciones y cualquier notificación importante de tus campañas.`);
      log.push({ paso: 'Bienvenida canal cliente', ok: true });
    }

    return res.json({
      ok: true,
      clinica,
      slackCanal: `#${slackChannelName}`,
      slackChannelId,
      ambiente: esProduccion ? 'Producción' : 'Testing',
      log
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, log });
  }
};