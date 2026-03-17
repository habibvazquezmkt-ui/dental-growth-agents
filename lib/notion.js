const NOTION_API = 'https://api.notion.com/v1';
const getHeaders = () => ({
  'Authorization': `Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
});
const DB = {
  COBRANZA: 'c4b90d4f-2652-4530-a7fe-5fcd5957ab9e',
  CANALES:  '9caf13e3-f135-4ffe-9d9c-a7616bfc2642',
  AGENTES:  'e99ffff6-9e7a-4051-864e-b00d09568246',
  COLA:     '74f55166-e5bc-4c10-bea3-bdfb1cf7f74f'
};
async function queryDatabase(databaseId, filter = null) {
  const body = filter ? { filter } : {};
  const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(body)
  });
  return (await res.json()).results || [];
}
async function getCobrosActivos() {
  return queryDatabase(DB.COBRANZA, {
    or: [
      { property: 'Status Pago', status: { equals: 'Pendiente' } },
      { property: 'Status Pago', status: { equals: 'Vencido' } }
    ]
  });
}
async function getSlackIdPorNombre(nombreClinica) {
  const canales = await queryDatabase(DB.CANALES);
  const canal = canales.find(c => {
    const n = (c.properties['Clinica'] || c.properties['Cl\u00ednica'])?.title?.[0]?.plain_text || '';
    const base = n.toLowerCase().split('\u2014')[0].trim();
    const buscar = nombreClinica.toLowerCase().split('\u2014')[0].trim();
    return base.includes(buscar) || buscar.includes(base);
  });
  return canal?.properties['WhatsApp Grupo ID']?.rich_text?.[0]?.plain_text || null;
}
async function actualizarStatusPago(pageId, status, fechaPagoReal = null) {
  const props = { 'Status Pago': { status: { name: status } } };
  if (fechaPagoReal) props['Fecha Pago Real'] = { date: { start: fechaPagoReal } };
  await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ properties: props })
  });
}
async function agregarNota(pageId, nota) {
  const page = await fetch(`${NOTION_API}/pages/${pageId}`, { headers: getHeaders() }).then(r => r.json());
  const actual = page.properties['Notas']?.rich_text?.[0]?.plain_text || '';
  const nueva = `${actual ? actual + '\n' : ''}[${new Date().toLocaleDateString('es-MX')}] ${nota}`;
  await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH', headers: getHeaders(),
    body: JSON.stringify({ properties: { 'Notas': { rich_text: [{ text: { content: nueva } }] } } })
  });
}
async function isAgenteActivo(nombre) {
  const agentes = await queryDatabase(DB.AGENTES);
  const agente = agentes.find(a => (a.properties['Agente']?.title?.[0]?.plain_text || '').includes(nombre));
  return agente?.properties['Estado Operativo']?.select?.name === 'Activo';
}
async function registrarNotificacion({ clinica, tipo, agente, canal, mensaje, ambiente }) {
  await fetch(`${NOTION_API}/pages`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({
      parent: { database_id: DB.COLA },
      properties: {
        'Notificaci\u00f3n': { title: [{ text: { content: `${tipo} \u2014 ${clinica}` } }] },
        'Tipo':          { select: { name: tipo } },
        'Agente':        { select: { name: agente } },
        'Canal':         { select: { name: canal } },
        'Ambiente':      { select: { name: ambiente } },
        'Estado':        { select: { name: 'Enviado' } },
        'Mensaje':       { rich_text: [{ text: { content: mensaje.substring(0, 2000) } }] },
        'Fecha Enviado': { date: { start: new Date().toISOString().split('T')[0] } }
      }
    })
  });
}
module.exports = { getCobrosActivos, getSlackIdPorNombre, actualizarStatusPago, agregarNota, isAgenteActivo, registrarNotificacion };
