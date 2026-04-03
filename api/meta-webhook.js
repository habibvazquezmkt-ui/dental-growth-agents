/**
 * Meta Lead Ads → Notion Pipeline + Slack
 * Webhook para Dental Growth v3
 *
 * Recibe leads de Meta Instant Forms y:
 * 1. Busca el formulario en el Form Registry de Notion (multi-form support)
 * 2. Verifica duplicados en Pipeline por telefono/email
 * 3. Crea registro en Pipeline de Ventas con metadata del form
 * 4. Notifica en Slack con los datos del lead
 *
 * v3: Process before respond + verbose logging + extras parsing
 */

const { enviarMensaje } = require('../lib/slack');

// --- Config ---
const NOTION_API = 'https://api.notion.com/v1';
const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || 'dental_growth_verify_2026';
const ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
const PIPELINE_DB_ID = process.env.NOTION_PIPELINE_DB_ID || '279f5e57-2262-4451-a103-7d0e1de3a70c';
const FORM_REGISTRY_DB_ID = process.env.NOTION_FORM_REGISTRY_DB_ID || 'd4cad324-29e8-4cd8-bd2b-0d2f311e171d';
const LEADS_CHANNEL_ID = process.env.SLACK_LEADS_CHANNEL_ID || '';

const DEFAULT_CLOSER_PAGE_ID = '330143ab281f81d1883fd3902dc42176';
const DEFAULT_VALOR_MENSUAL = 5000;

const getNotionHeaders = () => ({
  'Authorization': `Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
});

// === ENV DIAGNOSTICS (logs on first invocation) ===
console.log('[INIT] meta-webhook v3 loaded');
console.log('[INIT] ACCESS_TOKEN set:', !!ACCESS_TOKEN, ACCESS_TOKEN ? `(${ACCESS_TOKEN.substring(0, 10)}...)` : '(empty)');
console.log('[INIT] NOTION_API_KEY set:', !!(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN));
console.log('[INIT] SLACK_BOT_TOKEN set:', !!process.env.SLACK_BOT_TOKEN);
console.log('[INIT] LEADS_CHANNEL_ID:', LEADS_CHANNEL_ID || '(empty)');
console.log('[INIT] PIPELINE_DB_ID:', PIPELINE_DB_ID);

// === UTILIDADES ===

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.status < 500) return resp;
      console.warn(`[RETRY] Status ${resp.status} en intento ${attempt + 1}`);
    } catch (e) {
      console.warn(`[RETRY] Intento ${attempt + 1}/${maxRetries} fallo: ${e.message}`);
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

async function getMetaLeadData(leadgenId) {
  const url = `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${ACCESS_TOKEN}`;
  console.log(`[META] Fetching lead data: ${leadgenId}`);
  const resp = await fetchWithRetry(url, { method: 'GET' });
  if (resp && resp.ok) {
    const data = await resp.json();
    console.log(`[META] Lead data OK: ${JSON.stringify(data).substring(0, 200)}`);
    return data;
  }
  const errBody = resp ? await resp.text() : 'sin respuesta';
  console.error(`[META] Error obteniendo lead ${leadgenId}: status=${resp?.status} body=${errBody.substring(0, 300)}`);
  return null;
}

function parseLeadFields(fieldData) {
  const result = { name: '', email: '', phone: '', extras: [] };
  for (const field of fieldData) {
    const fname = (field.name || '').toLowerCase();
    const value = (field.values || [])[0] || '';
    if (['name', 'nombre', 'full_name', 'nombre_completo'].some(k => fname.includes(k))) {
      result.name = value;
    } else if (['email', 'correo', 'e-mail'].some(k => fname.includes(k))) {
      result.email = value;
    } else if (['phone', 'tel', 'whatsapp', 'celular', 'movil'].some(k => fname.includes(k))) {
      result.phone = value;
    } else if (value && !value.startsWith('<test lead:')) {
      const cleanName = field.name.replace(/_/g, ' ').replace(/,/g, '').substring(0, 50);
      result.extras.push(`${cleanName}: ${value.substring(0, 100)}`);
    }
  }
  return result;
}

async function getFormMetadata(formId) {
  if (!FORM_REGISTRY_DB_ID) return null;
  console.log(`[FORM] Buscando form ${formId} en registry...`);

  const resp = await fetchWithRetry(
    `${NOTION_API}/databases/${FORM_REGISTRY_DB_ID}/query`,
    {
      method: 'POST',
      headers: getNotionHeaders(),
      body: JSON.stringify({
        filter: {
          property: 'Meta Form ID',
          rich_text: { equals: String(formId) }
        }
      })
    }
  );

  if (resp && resp.ok) {
    const data = await resp.json();
    const results = data.results || [];
    if (results.length > 0) {
      const props = results[0].properties || {};
      console.log(`[FORM] Encontrado en registry: ${props['Nombre Form']?.title?.[0]?.plain_text || 'sin nombre'}`);
      return {
        nombre_form: props['Nombre Form']?.title?.[0]?.plain_text || '',
        campana: props['Campana']?.rich_text?.[0]?.plain_text || '',
        tratamiento: props['Tratamiento']?.select?.name || '',
        fuente: props['Fuente']?.select?.name || '',
        closer_id: props['Closer Asignado']?.relation?.[0]?.id || '',
        notas: props['Notas']?.rich_text?.[0]?.plain_text || '',
      };
    }
    console.log(`[FORM] Form ${formId} no encontrado en registry`);
  } else {
    const err = resp ? await resp.text() : 'sin respuesta';
    console.error(`[FORM] Error consultando registry: ${err.substring(0, 200)}`);
  }
  return null;
}

async function getMetaFormName(formId) {
  const url = `https://graph.facebook.com/v19.0/${formId}?fields=name,status,created_time,page_id&access_token=${ACCESS_TOKEN}`;
  const resp = await fetchWithRetry(url, { method: 'GET' });
  if (resp && resp.ok) return resp.json();
  console.warn(`[FORM] No se pudo obtener info del form ${formId} desde Meta`);
  return null;
}

async function autoRegisterForm(formId) {
  if (!FORM_REGISTRY_DB_ID || !formId) return null;
  const metaForm = await getMetaFormName(formId);
  const formName = metaForm?.name || `Form ${formId}`;
  const createdTime = metaForm?.created_time
    ? metaForm.created_time.split('T')[0]
    : new Date().toISOString().split('T')[0];

  console.log(`[FORM] Auto-registrando: ${formName} (${formId})`);

  const properties = {
    'Nombre Form': { title: [{ text: { content: formName } }] },
    'Meta Form ID': { rich_text: [{ text: { content: String(formId) } }] },
    'Status': { select: { name: 'Activo' } },
    'Fuente': { select: { name: 'Facebook Ads' } },
    'Tratamiento': { select: { name: 'General' } },
    'Leads Recibidos': { number: 1 },
    'Notas': { rich_text: [{ text: { content: 'Auto-registrado por webhook al recibir primer lead' } }] },
  };

  const resp = await fetchWithRetry(
    `${NOTION_API}/pages`,
    {
      method: 'POST',
      headers: getNotionHeaders(),
      body: JSON.stringify({
        parent: { database_id: FORM_REGISTRY_DB_ID },
        properties,
      })
    }
  );

  if (resp && resp.ok) {
    const page = await resp.json();
    console.log(`[FORM] Auto-registrado OK: ${formName} (${page.id})`);
    return {
      nombre_form: formName,
      campana: '',
      tratamiento: 'General',
      fuente: 'Facebook Ads',
      closer_id: '',
      notas: 'Auto-registrado por webhook',
    };
  } else {
    const err = resp ? await resp.text() : 'sin respuesta';
    console.error(`[FORM] Error auto-registrando: ${err.substring(0, 200)}`);
    return null;
  }
}

async function checkDuplicate(phone, email) {
  const filters = [];
  if (phone) filters.push({ property: 'Telefono', phone_number: { equals: phone } });
  if (email) filters.push({ property: 'Email', email: { equals: email } });
  if (filters.length === 0) {
    console.log('[DUP] Sin phone/email, saltando check de duplicados');
    return false;
  }

  const resp = await fetchWithRetry(
    `${NOTION_API}/databases/${PIPELINE_DB_ID}/query`,
    {
      method: 'POST',
      headers: getNotionHeaders(),
      body: JSON.stringify({ filter: { or: filters } })
    }
  );

  if (resp && resp.ok) {
    const data = await resp.json();
    if ((data.results || []).length > 0) {
      console.log(`[DUP] Duplicado encontrado: ${phone || email}`);
      return true;
    }
  }
  console.log('[DUP] No es duplicado');
  return false;
}

async function createPipelineRecord(lead, formMeta) {
  const today = new Date().toISOString().split('T')[0];
  let fuente = 'Facebook Ads';
  let closerId = DEFAULT_CLOSER_PAGE_ID;
  let notasExtra = '';

  if (formMeta) {
    if (formMeta.fuente) fuente = formMeta.fuente;
    if (formMeta.closer_id) closerId = formMeta.closer_id;
    const parts = [];
    if (formMeta.nombre_form) parts.push(`Form: ${formMeta.nombre_form}`);
    if (formMeta.campana) parts.push(`Campana: ${formMeta.campana}`);
    if (formMeta.tratamiento) parts.push(`Tratamiento: ${formMeta.tratamiento}`);
    if (formMeta.notas) parts.push(formMeta.notas);
    notasExtra = parts.join(' | ');
  }

  if (lead.extras && lead.extras.length > 0) {
    notasExtra += (notasExtra ? '\n' : '') + 'Respuestas: ' + lead.extras.join(' | ');
  }

  const properties = {
    'Prospecto': { title: [{ text: { content: lead.name || 'Lead sin nombre' } }] },
    'Etapa': { select: { name: 'Nuevo Lead' } },
    'Fuente': { select: { name: fuente } },
    'Fecha Primer Contacto': { date: { start: today } },
    'Valor Mensual': { number: DEFAULT_VALOR_MENSUAL },
    'Closer': { relation: [{ id: closerId }] },
    'Notas': { rich_text: [{ text: { content: `Lead automatico desde Meta Ads. ${notasExtra}`.trim().substring(0, 2000) } }] },
  };

  if (lead.email) properties['Email'] = { email: lead.email };
  if (lead.phone) properties['Telefono'] = { phone_number: lead.phone };

  console.log(`[PIPELINE] Creando registro: ${lead.name || 'Lead sin nombre'}`);

  const resp = await fetchWithRetry(
    `${NOTION_API}/pages`,
    {
      method: 'POST',
      headers: getNotionHeaders(),
      body: JSON.stringify({
        parent: { database_id: PIPELINE_DB_ID },
        properties
      })
    }
  );

  if (resp && resp.ok) {
    const page = await resp.json();
    console.log(`[PIPELINE] Registro creado OK: ${page.id}`);
    return page.id;
  } else {
    const err = resp ? await resp.text() : 'sin respuesta';
    console.error(`[PIPELINE] Error creando registro: ${err.substring(0, 300)}`);
    return null;
  }
}

async function notifySlack(lead, pageId, formMeta) {
  if (!LEADS_CHANNEL_ID) {
    console.warn('[SLACK] LEADS_CHANNEL_ID no configurado, saltando');
    return;
  }

  const now = new Date();
  const fecha = now.toLocaleDateString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Tijuana'
  });

  const notionLink = pageId
    ? `https://www.notion.so/${pageId.replace(/-/g, '')}`
    : '';

  let formInfo = '';
  if (formMeta) {
    const parts = [];
    if (formMeta.nombre_form) parts.push(formMeta.nombre_form);
    if (formMeta.tratamiento) parts.push(formMeta.tratamiento);
    if (formMeta.campana) parts.push(formMeta.campana);
    formInfo = parts.join(' | ');
  }

  let text = `*Nuevo Lead desde Meta Ads*\n\n`;
  text += `*${lead.name || 'Sin nombre'}*\n`;
  text += `Tel: ${lead.phone || '---'}\n`;
  text += `Email: ${lead.email || '---'}\n`;
  if (formInfo) text += `Formulario: ${formInfo}\n`;
  if (lead.extras && lead.extras.length > 0) {
    text += `Respuestas: ${lead.extras.join(' | ')}\n`;
  }
  text += `Fecha: ${fecha}\n\n`;
  text += `Asignado a: Damina\n`;
  text += `Valor estimado: $5,000 MXN/mes\n`;
  if (notionLink) text += `\n<${notionLink}|Ver en Notion>`;

  console.log(`[SLACK] Enviando a canal ${LEADS_CHANNEL_ID}`);
  const result = await enviarMensaje(LEADS_CHANNEL_ID, text);
  console.log(`[SLACK] Resultado: ${JSON.stringify(result).substring(0, 200)}`);
}

// === PROCESAMIENTO DE LEADS ===

async function processLeads(data) {
  const entries = data.entry || [];
  console.log(`[PROCESS] Entries: ${entries.length}`);

  for (const entry of entries) {
    const changes = entry.changes || [];
    console.log(`[PROCESS] Changes en entry: ${changes.length}`);

    for (const change of changes) {
      const value = change.value || {};
      const leadgenId = value.leadgen_id;
      const formId = value.form_id || '';

      if (!leadgenId) {
        console.log('[PROCESS] Sin leadgen_id, saltando');
        continue;
      }

      console.log(`[PROCESS] Lead: ${leadgenId} (form: ${formId})`);

      // 1. Obtener datos del lead desde Meta
      const leadData = await getMetaLeadData(leadgenId);
      if (!leadData) {
        console.error(`[PROCESS] No se pudo obtener lead ${leadgenId}, saltando`);
        continue;
      }

      const fieldData = leadData.field_data || [];
      const lead = parseLeadFields(fieldData);
      console.log(`[PROCESS] Parseado: name=${lead.name}, email=${lead.email}, phone=${lead.phone}, extras=${lead.extras.length}`);

      // 2. Buscar metadata del formulario
      let formMeta = await getFormMetadata(String(formId));
      if (!formMeta) {
        console.log(`[PROCESS] Form ${formId} no en registry, auto-registrando...`);
        formMeta = await autoRegisterForm(formId);
      }

      // 3. Verificar duplicados (solo si hay phone o email)
      if (lead.phone || lead.email) {
        const isDup = await checkDuplicate(lead.phone, lead.email);
        if (isDup) {
          console.log(`[PROCESS] Duplicado, ignorando: ${lead.name}`);
          continue;
        }
      }

      // 4. Crear registro en Pipeline
      const pageId = await createPipelineRecord(lead, formMeta);

      // 5. Notificar en Slack
      if (pageId) {
        await notifySlack(lead, pageId, formMeta);
      }

      console.log(`[PROCESS] Lead procesado OK: ${lead.name || 'sin nombre'}`);
    }
  }
}

// === HANDLER PRINCIPAL (Vercel Serverless) ===

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[HANDLER] Webhook verificado OK');
      return res.status(200).send(challenge);
    } else {
      console.warn(`[HANDLER] Verificacion fallida: mode=${mode}`);
      return res.status(403).send('Forbidden');
    }
  }

  if (req.method === 'POST') {
    const data = req.body;
    console.log(`[HANDLER] POST recibido: ${JSON.stringify(data).substring(0, 300)}`);

    try {
      await processLeads(data);
      console.log('[HANDLER] Procesamiento completado OK');
    } catch (e) {
      console.error(`[HANDLER] Error: ${e.message}\n${e.stack}`);
    }

    return res.status(200).json({ status: 'ok' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
