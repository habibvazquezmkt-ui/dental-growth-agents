const { getCobrosActivos, getSlackIdPorNombre, actualizarStatusPago, agregarNota, isAgenteActivo, registrarNotificacion } = require('../lib/notion');
const { enviarMensaje } = require('../lib/slack');
const { analizarIntencionPago, generarMensajeCobro } = require('../lib/claude');
const SLACK_HABIB = process.env.SLACK_HABIB_CHANNEL || 'C0A5NEJ0QHL';

module.exports = async function handler(req, res) {
  if (req.method === 'POST' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  if (req.method === 'POST' && req.body?.event) {
    return await handleSlackEvent(req, res);
  }
  return await runCronCobros(req, res);
};

async function handleSlackEvent(req, res) {
  const { event } = req.body;
  if (event?.type !== 'message' || event.bot_id || event.subtype) {
    return res.json({ ok: true });
  }
  const mensaje = event.text || '';
  const channelId = event.channel;
  const { es_confirmacion } = await analizarIntencionPago(mensaje);
  if (es_confirmacion) {
    const cobros = await getCobrosActivos();
    for (const cobro of cobros) {
      const concepto = cobro.properties['Concepto']?.title?.[0]?.plain_text || '';
      const slackId = await getSlackIdPorNombre(concepto);
      if (slackId === channelId) {
        const hoy = new Date().toISOString().split('T')[0];
        const monto = cobro.properties['Monto']?.number || 0;
        await actualizarStatusPago(cobro.id, 'Cobrado', hoy);
        await agregarNota(cobro.id, `Pago confirmado via Slack. Mensaje: "${mensaje.substring(0, 100)}"`);
        await registrarNotificacion({ clinica: concepto, tipo: 'Cobranza', agente: 'Agente IA Cobros', canal: 'Slack Testing', ambiente: 'Testing', mensaje: `Pago confirmado: ${concepto} - $${monto.toLocaleString('es-MX')} MXN` });
        await enviarMensaje(SLACK_HABIB, `Cobro confirmado\nCliente: ${concepto}\nMonto: $${monto.toLocaleString('es-MX')} MXN\nFecha: ${hoy}\nActualizado en Notion automaticamente`);
        break;
      }
    }
  }
  res.json({ ok: true });
}

async function runCronCobros(req, res) {
  const activo = await isAgenteActivo('Cobros');
  if (!activo) return res.json({ ok: true, message: 'Agente pausado en Notion. Sin accion.' });
  const hoy = new Date();
  const cobros = await getCobrosActivos();
  const acciones = [];
  for (const cobro of cobros) {
    const concepto = cobro.properties['Concepto']?.title?.[0]?.plain_text || '';
    const monto = cobro.properties['Monto']?.number || 0;
    const fechaStr = cobro.properties['Fecha de Cobro']?.date?.start;
    if (!fechaStr) continue;
    const diasDiff = Math.floor((hoy - new Date(fechaStr)) / (1000 * 60 * 60 * 24));
    const clinica = concepto.split('\u2014')[0].trim();
    let tipo = null;
    if (diasDiff === -3) tipo = 'recordatorio';
    else if (diasDiff === 0) tipo = 'cobro';
    else if (diasDiff === 2) tipo = 'seguimiento1';
    else if (diasDiff === 5) tipo = 'seguimiento2';
    else if (diasDiff === 10) tipo = 'seguimiento3';
    if (!tipo) continue;
    const mensaje = await generarMensajeCobro({ tipo, clinica, monto, fecha: fechaStr, diasRetraso: Math.max(0, diasDiff) });
    await registrarNotificacion({ clinica, tipo: 'Cobranza', agente: 'Agente IA Cobros', canal: 'Slack Testing', ambiente: 'Testing', mensaje });
    if (diasDiff >= 10) {
      await actualizarStatusPago(cobro.id, 'Vencido');
      await agregarNota(cobro.id, `Sin pago despues de ${diasDiff} dias. Alerta enviada a Habib.`);
      await enviarMensaje(SLACK_HABIB, `Cobro vencido - ${diasDiff} dias sin pago\nCliente: ${clinica}\nMonto: $${monto.toLocaleString('es-MX')} MXN\nFecha cobro: ${fechaStr}\nRevisar si pausar el servicio`);
    }
    acciones.push({ clinica, tipo, diasDiff });
  }
  res.json({ ok: true, procesados: cobros.length, acciones });
}