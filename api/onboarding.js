const { enviarMensaje, crearCanal } = require('../lib/slack');
const { registrarNotificacion } = require('../lib/notion');
const NOTION_API = 'https://api.notion.com/v1';
const SLACK_HABIB = process.env.SLACK_HABIB_CHANNEL || 'C0A5NEJ0QHL';
const getH = () => ({
  'Authorization': `Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
});
const DB = {
  CLINICAS: '16178dfd-fa7e-4b5a-884d-445cb1041f6a',
  COBRANZA: 'c4b90d4f-2652-4530-a7fe-5fcd5957ab9e',
  CANALES:  '9caf13e3-f135-4ffe-9d9c-a7616bfc2642'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { clinica, doctor, telefono, ciudad, monto, fechaCobro, ambiente } = req.body;
  if (!clinica || !doctor) return res.status(400).json({ error: 'Faltan: clinica y doctor' });

  const prod = ambiente === 'Produccion' || ambiente === 'Producción';
  const nombreCanal = `${prod ? 'soporte' : 'test'}_${clinica.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60)}`;
  const hoy = new Date().toISOString().split('T')[0];
  const fc = fechaCobro || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().split('T')[0];
  const log = [];

  try {
    // 1. Canal Slack
    const slackRes = await crearCanal(nombreCanal);
    const slackId = slackRes?.channel?.id || null;
    const slackName = slackRes?.channel?.name || nombreCanal;
    log.push({ paso: 'Slack', ok: !!slackId, id: slackId, error: slackRes?.error || null });

    // 2. Alta en Clínicas — formato REST API correcto
    const cp = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getH(),
      body: JSON.stringify({
        parent: { database_id: DB.CLINICAS },
        properties: {
          'Clínica':           { title:      [{ text: { content: clinica } }] },
          'Doctor / Contacto': { rich_text:  [{ text: { content: doctor } }] },
          'Ciudad':            { rich_text:  [{ text: { content: ciudad || '' } }] },
          'Teléfono':          { phone_number: telefono || null },
          'Precio Mensual':    { number: monto || 0 },
          'Status':            { select: { name: prod ? 'En Onboarding' : 'Prospecto' } },
          'Paquete':           { select: { name: 'Estándar' } },
          'Fecha Alta':        { date: { start: hoy } }
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Clinicas', ok: !!cp.id, error: cp.message || null });

    // 3. Alta en Cobranza — formato REST API correcto
    const cobp = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getH(),
      body: JSON.stringify({
        parent: { database_id: DB.COBRANZA },
        properties: {
          'Concepto':        { title:     [{ text: { content: `Mensualidad ${clinica}` } }] },
          'Monto':           { number: monto || 3000 },
          'Status Pago':     { status: { name: 'Pendiente' } },
          'Fecha de Cobro':  { date: { start: fc } },
          'Notas':           { rich_text: [{ text: { content: `Onboarding auto. Dr: ${doctor}. Ciudad: ${ciudad || 'N/A'}` } }] }
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Cobranza', ok: !!cobp.id, error: cobp.message || null });

    // 4. Canales de Comunicación
    const canp = await fetch(`${NOTION_API}/pages`, {
      method: 'POST', headers: getH(),
      body: JSON.stringify({
        parent: { database_id: DB.CANALES },
        properties: {
          'Clínica':             { title:     [{ text: { content: clinica } }] },
          'Canal Slack Testing': { rich_text: [{ text: { content: `#${slackName}` } }] },
          'WhatsApp Grupo ID':   { rich_text: [{ text: { content: slackId || '' } }] },
          'Ambiente':            { select: { name: prod ? 'Producción' : 'Testing' } },
          'Activo':              { checkbox: true },
          'Notas':               { rich_text: [{ text: { content: `Auto-creado. Slack ID: ${slackId}` } }] }
        }
      })
    }).then(r => r.json());
    log.push({ paso: 'Canales', ok: !!canp.id, error: canp.message || null });

    // 5. Cola + Notificación
    await registrarNotificacion({ clinica, tipo: 'Bienvenida', agente: 'Sistema', canal: 'Slack Testing', ambiente: prod ? 'Producción' : 'Testing', mensaje: `Onboarding: ${clinica}. Canal: #${slackName}. Dr: ${doctor}.` });
    log.push({ paso: 'Cola', ok: true });

    await enviarMensaje(SLACK_HABIB, `*Onboarding completado*\n*Clínica:* ${clinica}\n*Doctor:* ${doctor}\n*Ciudad:* ${ciudad || 'N/A'}\n*Mensualidad:* $${(monto||3000).toLocaleString('es-MX')} MXN\n*Canal:* #${slackName}\n*Ambiente:* ${prod ? 'Producción' : 'Testing'}`);
    log.push({ paso: 'Notificación', ok: true });

    if (prod && slackId) {
      await enviarMensaje(slackId, `Bienvenido a Dental Growth, ${doctor}. Este es tu canal directo con nuestro equipo.`);
    }

    res.json({ ok: true, clinica, slackCanal: `#${slackName}`, slackChannelId: slackId, log });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, log });
  }
};
