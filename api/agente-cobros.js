const { actualizarStatusPago, isAgenteActivo, registrarNotificacion } = require('../lib/notion');
const { enviarMensaje } = require('../lib/slack');

const SLACK_COBRANZA = process.env.SLACK_CHANNEL_ID || 'C0A4RHERX0T';
const NOTION_DB_ID   = 'c4b90d4f-2652-4530-a7fe-5fcd5957ab9e';
const NOTION_VERSION = '2022-06-28';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hoy() {
  const mx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Tijuana' }));
  return mx.toISOString().split('T')[0];
}

function formatearFecha(iso) {
  if (!iso) return 'Sin fecha';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatearMonto(num) {
  if (num == null) return '$0 MXN';
  return `$${Number(num).toLocaleString('es-MX')} MXN`;
}

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// ─── Paginación completa ──────────────────────────────────────────────────────
// Lee TODOS los registros con "Incluir en Bot" = true
// Usa has_more + next_cursor para garantizar cobertura del 100%

async function leerTodosLosCobros() {
  const registros = [];
  let cursor = undefined;

  while (true) {
    const body = {
      filter: { property: 'Incluir en Bot', checkbox: { equals: true } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res  = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    registros.push(...data.results);

    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  return registros;
}

// ─── Cache de relaciones ──────────────────────────────────────────────────────

const _cache = {};
async function resolverNombrePagina(pageId) {
  if (!pageId) return null;
  const id = pageId.replace(/-/g, '');
  if (_cache[id]) return _cache[id];
  try {
    const res  = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
    const page = await res.json();
    const props = page.properties || {};
    for (const key of Object.keys(props)) {
      if (props[key].type === 'title') {
        const nombre = props[key].title.map(t => t.plain_text).join('');
        _cache[id] = nombre;
        return nombre;
      }
    }
  } catch (e) { /* silencioso */ }
  return null;
}

// ─── Parsear registro ─────────────────────────────────────────────────────────

async function parsear(record) {
  const p = record.properties;
  const fechaCobro  = p['Fecha de Cobro']?.date?.start || null;
  const precioBase  = p['Precio Base']?.number ?? null;
  const statusPago  = p['Status Pago']?.select?.name || '';
  const concepto    = (p['Concepto']?.title || []).map(t => t.plain_text).join('');

  // IDs de relaciones
  const doctorId      = p['Doctor']?.relation?.[0]?.id || null;
  const clinicaId     = p['Clínica']?.relation?.[0]?.id || null;
  const responsableId = p['Responsable Cobro']?.relation?.[0]?.id || null;

  // Resolver nombres en paralelo
  const [doctor, clinica, responsable] = await Promise.all([
    resolverNombrePagina(doctorId),
    resolverNombrePagina(clinicaId),
    resolverNombrePagina(responsableId),
  ]);

  return { id: record.id, concepto, fechaCobro, precioBase, statusPago, doctor, clinica, responsable };
}

// ─── Construir línea del reporte ──────────────────────────────────────────────

function linea(cobro, mostrarFecha = false) {
  const quien  = cobro.doctor  ? `Dr(a). ${cobro.doctor}`  : cobro.concepto;
  const donde  = cobro.clinica || 'Sin clínica';
  const monto  = formatearMonto(cobro.precioBase);
  const resp   = cobro.responsable ? ` — Responsable: ${cobro.responsable}` : '';
  const fecha  = mostrarFecha ? ` — Fecha: ${formatearFecha(cobro.fechaCobro)}` : '';
  return `• ${quien} — ${donde} — ${monto}${fecha}${resp}`;
}

// ─── Handler principal ────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Soporte para Slack url_verification
  if (req.method === 'POST' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  try {
    // 1. Verificar si el agente está activo en Notion
    const activo = await isAgenteActivo('Cobros');
    if (!activo) {
      return res.json({ ok: true, message: 'Agente pausado en Notion. Sin acción.' });
    }

    // 2. Leer TODOS los registros con paginación completa
    const registros = await leerTodosLosCobros();
    const cobros    = await Promise.all(registros.map(parsear));

    const hoyStr     = hoy();
    const en7dias    = new Date(hoyStr);
    en7dias.setDate(en7dias.getDate() + 7);
    const en7diasStr = en7dias.toISOString().split('T')[0];

    // 3. Categorizar POR FECHA — ignorar status para la categorización
    const vencidos = cobros.filter(c => c.fechaCobro && c.fechaCobro < hoyStr);
    const hoyList  = cobros.filter(c => c.fechaCobro === hoyStr);
    const proximos = cobros.filter(c => c.fechaCobro > hoyStr && c.fechaCobro <= en7diasStr);

    // 4. Marcar como Vencido en Notion los que corresponda (excluyendo Cobrado/Cancelado)
    const aActualizar = vencidos.filter(c => c.statusPago !== 'Cobrado' && c.statusPago !== 'Cancelado');
    await Promise.all(aActualizar.map(c => actualizarStatusPago(c.id, 'Vencido')));

    // 5. Construir mensaje Slack
    const totalPendiente = [...vencidos, ...hoyList, ...proximos]
      .filter(c => c.statusPago !== 'Cobrado' && c.statusPago !== 'Cancelado')
      .reduce((s, c) => s + (c.precioBase || 0), 0);

    const secVencidos = vencidos.length
      ? vencidos.map(c => `${linea(c)} — Venció: ${formatearFecha(c.fechaCobro)}`).join('\n')
      : 'Sin cobros vencidos ✅';

    const secHoy = hoyList.length
      ? hoyList.map(c => linea(c)).join('\n')
      : 'Sin cobros para hoy';

    const secProximos = proximos.length
      ? proximos.map(c => linea(c, true)).join('\n')
      : 'Sin cobros próximos';

    const mensaje = [
      `*Reporte de Cobranza — ${formatearFecha(hoyStr)}*`,
      `_${cobros.length} registros revisados — cobertura completa_`,
      '',
      `🔴 *VENCIDOS* (cobrar urgente)`,
      secVencidos,
      '',
      `🟡 *HOY*`,
      secHoy,
      '',
      `🟢 *PRÓXIMOS 7 DÍAS*`,
      secProximos,
      '',
      `*Resumen:* ${vencidos.length} vencidos | ${hoyList.length} hoy | ${proximos.length} próximos 7 días | Total pendiente: ${formatearMonto(totalPendiente)}`,
    ].join('\n');

    // 6. Enviar a Slack
    await enviarMensaje(SLACK_COBRANZA, mensaje);

    // 7. Registrar en cola de Notion
    await registrarNotificacion({
      clinica:  'Dental Growth',
      tipo:     'Cobranza',
      agente:   'Agente IA Cobros',
      canal:    'Slack',
      ambiente: 'Production',
      mensaje:  `Reporte enviado: ${vencidos.length} vencidos, ${hoyList.length} hoy, ${proximos.length} próximos. ${cobros.length} registros revisados.`,
    });

    return res.json({
      ok: true,
      revisados:   cobros.length,
      vencidos:    vencidos.length,
      hoy:         hoyList.length,
      proximos_7d: proximos.length,
    });

  } catch (error) {
    // FALLBACK: si falla, avisar a Slack para revisión manual
    try {
      await enviarMensaje(SLACK_COBRANZA, [
        `⚠️ *ERROR — Agente de Cobranza — ${formatearFecha(hoy())}*`,
        `El agente falló y *no pudo generar el reporte de hoy*.`,
        `Error: \`${error.message}\``,
        `👉 <https://www.notion.so/c4b90d4f26524530a7fe5fcd5957ab9e|Revisar Cobranza en Notion manualmente>`,
      ].join('\n'));
    } catch (_) { /* si Slack también falla, no podemos hacer más */ }

    return res.status(500).json({ ok: false, error: error.message });
  }
};
