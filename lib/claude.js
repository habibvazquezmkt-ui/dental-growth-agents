const API = 'https://api.anthropic.com/v1/messages';
const getHeaders = () => ({
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json'
});
async function analizarIntencionPago(mensaje) {
  const res = await fetch(API, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      system: 'Detecta si este mensaje confirma recepcion de un pago. Responde SOLO con JSON valido sin markdown: {"es_confirmacion": true} o {"es_confirmacion": false}. Senales: gracias por su pago, confirmamos de recibido, pago recibido, ya quedo, seguimos trabajando, recibimos.',
      messages: [{ role: 'user', content: `Mensaje: "${mensaje}"` }]
    })
  });
  const data = await res.json();
  try { return JSON.parse(data.content[0].text); }
  catch { return { es_confirmacion: false }; }
}
async function generarMensajeCobro({ tipo, clinica, monto, fecha, diasRetraso }) {
  const contextos = {
    recordatorio: 'Recordatorio cordial 3 dias antes del vencimiento',
    cobro: 'Mensaje de cobro el dia de vencimiento',
    seguimiento1: 'Primer seguimiento amable 2 dias despues sin pago',
    seguimiento2: 'Segundo seguimiento mas directo 5 dias despues',
    seguimiento3: 'Tercer y ultimo aviso 10 dias despues antes de pausar servicio'
  };
  const res = await fetch(API, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      system: 'Eres el asistente de cobros de Dental Growth. Redacta mensajes profesionales y cordiales en espanol. Sin emojis excesivos. Maximo 3 lineas.',
      messages: [{ role: 'user', content: `Tipo: ${tipo} (${contextos[tipo] || tipo})\nClinica: ${clinica}\nMonto: $${monto?.toLocaleString('es-MX')} MXN\nFecha cobro: ${fecha}\n${diasRetraso > 0 ? `Dias de retraso: ${diasRetraso}` : ''}\nRedacta el mensaje:` }]
    })
  });
  const data = await res.json();
  return data.content[0].text.trim();
}
module.exports = { analizarIntencionPago, generarMensajeCobro };