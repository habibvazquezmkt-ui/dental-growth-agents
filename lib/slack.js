const SLACK_API = 'https://slack.com/api';
const getHeaders = () => ({
  'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
  'Content-Type': 'application/json'
});
async function enviarMensaje(channelId, mensaje) {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({ channel: channelId, text: mensaje })
  });
  return res.json();
}
async function crearCanal(nombre) {
  const normalizado = nombre.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 80);
  const res = await fetch(`${SLACK_API}/conversations.create`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({ name: normalizado, is_private: true })
  });
  return res.json();
}
module.exports = { enviarMensaje, crearCanal };