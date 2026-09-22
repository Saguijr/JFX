/* =========================================================
   JFX PROSPECT — lógica do app (V1)
   Front-end em JS puro + backend em Google Apps Script/Sheets
   ========================================================= */

/* ---------- Constantes ---------- */

const STATUS_LABELS = {
  novo: 'Novo',
  contato_feito: 'Contato feito',
  negociando: 'Negociando',
  follow_up: 'Follow-up agendado',
  convertido: 'Convertido',
  descartado: 'Descartado',
};

const POTENCIAL_LABELS = { baixo: 'Baixo', medio: 'Médio', alto: 'Alto' };

// Pesos do Score JFX — ajuste aqui se quiser recalibrar a fórmula
const SCORE_PESOS = {
  semSite: 25,
  siteRuim: 20,
  instagramAtivo: 15,
  muitasAvaliacoes: 10,
  potencialAlto: 10,
  whatsappDisponivel: 10,
  enderecoConfirmado: 5,
  responsavelIdentificado: 5,
};
const LIMIAR_MUITAS_AVALIACOES = 20; // nº de avaliações no Google a partir do qual conta ponto

/* ---------- Estado ---------- */

const state = {
  apiUrl: localStorage.getItem('jfxApiUrl') || '',
  leads: [],
  quickFilter: null,
  leadAtualId: null,
};

/* ---------- Utilitários ---------- */

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'sim'].includes(v.toLowerCase());
  return false;
}

function formatCurrency(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

function formatDate(v) {
  if (!v) return '—';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : v;
}

function waLink(whatsapp) {
  let digits = String(whatsapp).replace(/\D/g, '');
  if (!digits.startsWith('55')) digits = '55' + digits;
  return `https://wa.me/${digits}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Score JFX ---------- */

function calcularScore(lead) {
  let score = 0;
  if (!lead.temSite) score += SCORE_PESOS.semSite;
  else if (lead.qualidadeSite === 'ruim') score += SCORE_PESOS.siteRuim;
  if (lead.instagramAtivo) score += SCORE_PESOS.instagramAtivo;
  if (Number(lead.gmbAvaliacoes) >= LIMIAR_MUITAS_AVALIACOES) score += SCORE_PESOS.muitasAvaliacoes;
  if (lead.potencialVenda === 'alto') score += SCORE_PESOS.potencialAlto;
  if (lead.whatsapp && String(lead.whatsapp).trim()) score += SCORE_PESOS.whatsappDisponivel;
  if (lead.endereco && String(lead.endereco).trim()) score += SCORE_PESOS.enderecoConfirmado;
  if (lead.responsavel && String(lead.responsavel).trim()) score += SCORE_PESOS.responsavelIdentificado;
  return Math.min(score, 100);
}

function calcularTemperatura(score) {
  if (score >= 70) return 'quente';
  if (score >= 40) return 'morno';
  return 'frio';
}

function normalizarLead(raw) {
  const lead = {
    id: raw.id || uuid(),
    empresa: raw.empresa || '',
    segmento: raw.segmento || '',
    responsavel: raw.responsavel || '',
    telefone: raw.telefone || '',
    whatsapp: raw.whatsapp || '',
    email: raw.email || '',
    endereco: raw.endereco || '',
    cidade: raw.cidade || '',
    instagram: raw.instagram || '',
    instagramAtivo: parseBool(raw.instagramAtivo),
    site: raw.site || '',
    temSite: parseBool(raw.temSite),
    qualidadeSite: raw.qualidadeSite || 'nao_se_aplica',
    precisaManutencao: parseBool(raw.precisaManutencao),
    gmbAvaliacoes: Number(raw.gmbAvaliacoes) || 0,
    gmbNota: Number(raw.gmbNota) || 0,
    observacoes: raw.observacoes || '',
    dataPrimeiroContato: raw.dataPrimeiroContato || '',
    ultimoContato: raw.ultimoContato || '',
    proximoFollowup: raw.proximoFollowup || '',
    status: raw.status || 'novo',
    potencialVenda: raw.potencialVenda || 'medio',
    valorEstimado: Number(raw.valorEstimado) || 0,
    criadoEm: raw.criadoEm || new Date().toISOString(),
  };
  lead.score = calcularScore(lead);
  lead.temperatura = calcularTemperatura(lead.score);
  return lead;
}

/* ---------- Cache local (fallback offline) ---------- */

function salvarCache(leads) {
  try { localStorage.setItem('jfxLeadsCache', JSON.stringify(leads)); } catch (e) { /* ignora */ }
}
function carregarCache() {
  try { return (JSON.parse(localStorage.getItem('jfxLeadsCache')) || []).map(normalizarLead); }
  catch (e) { return []; }
}

/* ---------- API (Google Apps Script) ---------- */

const API = {
  async list() {
    if (!state.apiUrl) throw new Error('sem-url');
    const res = await fetch(`${state.apiUrl}?action=list`);
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'erro-desconhecido');
    return data.leads || [];
  },
  // Envia como text/plain para evitar preflight CORS (Apps Script não responde OPTIONS)
  async send(action, payload) {
    if (!state.apiUrl) throw new Error('sem-url');
    const res = await fetch(state.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'erro-desconhecido');
    return data;
  },
  create(lead) { return this.send('create', { lead }); },
  update(lead) { return this.send('update', { lead }); },
  remove(id) { return this.send('delete', { id }); },
};

/* ---------- Sincronização ---------- */

function setSyncStatus(tipo, texto) {
  const pill = document.getElementById('syncStatus');
  pill.classList.remove('ok', 'error', 'loading');
  pill.classList.add(tipo);
  pill.querySelector('.sync-label').textContent = texto;
}

async function sincronizar() {
  if (!state.apiUrl) {
    setSyncStatus('error', 'Não conectado');
    return;
  }
  setSyncStatus('loading', 'Sincronizando…');
  try {
    const leads = await API.list();
    state.leads = leads.map(normalizarLead);
    salvarCache(state.leads);
    renderAll();
    setSyncStatus('ok', 'Sincronizado');
  } catch (err) {
    console.error(err);
    setSyncStatus('error', 'Falha ao sincronizar (clique p/ tentar de novo)');
    mostrarToast('Não foi possível sincronizar com o Google Sheets. Mostrando os últimos dados salvos neste navegador.', 'error');
  }
}

/* ---------- Toasts ---------- */

function mostrarToast(msg, tipo = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------- Modais ---------- */

function abrirModal(id) { document.getElementById(id).hidden = false; }
function fecharModal(id) { document.getElementById(id).hidden = true; }

/* ---------- Dashboard (cards de estatística) ---------- */

function ativo(lead) { return !['convertido', 'descartado'].includes(lead.status); }

function atualizarStats() {
  const hoje = new Date().toISOString().slice(0, 10);
  const prioritarios = state.leads.filter((l) => l.temperatura === 'quente' && ativo(l)).length;
  const ligarHoje = state.leads.filter((l) => l.proximoFollowup && l.proximoFollowup <= hoje && ativo(l)).length;
  const whatsapp = state.leads.filter((l) => l.whatsapp && ativo(l)).length;
  const followUp = state.leads.filter((l) => l.status === 'follow_up').length;
  const convertidos = state.leads.filter((l) => l.status === 'convertido').length;
  const descartados = state.leads.filter((l) => l.status === 'descartado').length;
  const pipeline = state.leads.filter(ativo).reduce((s, l) => s + (l.valorEstimado || 0), 0);

  document.getElementById('statPrioritarios').textContent = prioritarios;
  document.getElementById('statLigarHoje').textContent = ligarHoje;
  document.getElementById('statWhatsapp').textContent = whatsapp;
  document.getElementById('statFollowUp').textContent = followUp;
  document.getElementById('statConvertidos').textContent = convertidos;
  document.getElementById('statDescartados').textContent = descartados;
  document.getElementById('statPipeline').textContent = formatCurrency(pipeline);
}

function atualizarFiltroSegmento() {
  const select = document.getElementById('filterSegmento');
  const atual = select.value;
  const segmentos = [...new Set(state.leads.map((l) => l.segmento).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Todo segmento</option>' +
    segmentos.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  select.value = segmentos.includes(atual) ? atual : '';
}

/* ---------- Lista de leads (filtros + ranking) ---------- */

function leadsFiltrados() {
  const termo = document.getElementById('searchInput').value.trim().toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const temperatura = document.getElementById('filterTemperatura').value;
  const segmento = document.getElementById('filterSegmento').value;
  const sortBy = document.getElementById('sortBy').value;
  const hoje = new Date().toISOString().slice(0, 10);

  let lista = [...state.leads];

  switch (state.quickFilter) {
    case 'prioritarios': lista = lista.filter((l) => l.temperatura === 'quente' && ativo(l)); break;
    case 'ligar-hoje': lista = lista.filter((l) => l.proximoFollowup && l.proximoFollowup <= hoje && ativo(l)); break;
    case 'whatsapp': lista = lista.filter((l) => l.whatsapp && ativo(l)); break;
    case 'follow-up': lista = lista.filter((l) => l.status === 'follow_up'); break;
    case 'convertido': lista = lista.filter((l) => l.status === 'convertido'); break;
    case 'descartado': lista = lista.filter((l) => l.status === 'descartado'); break;
    case 'pipeline': lista = lista.filter(ativo); break;
  }

  if (termo) {
    lista = lista.filter((l) => [l.empresa, l.cidade, l.responsavel].join(' ').toLowerCase().includes(termo));
  }
  if (status) lista = lista.filter((l) => l.status === status);
  if (temperatura) lista = lista.filter((l) => l.temperatura === temperatura);
  if (segmento) lista = lista.filter((l) => l.segmento === segmento);

  lista.sort((a, b) => {
    if (sortBy === 'valor') return b.valorEstimado - a.valorEstimado;
    if (sortBy === 'recente') return (b.ultimoContato || '').localeCompare(a.ultimoContato || '');
    if (sortBy === 'nome') return a.empresa.localeCompare(b.empresa, 'pt-BR');
    return b.score - a.score;
  });
  return lista;
}

function renderLeadCard(lead) {
  const statusLabel = STATUS_LABELS[lead.status] || lead.status;
  const tempIcon = { quente: '🔥', morno: '🟡', frio: '🧊' }[lead.temperatura];
  return `
    <article class="lead-card" data-id="${lead.id}">
      <div class="score-badge ${lead.temperatura}" data-action="detalhes">
        <span>${tempIcon}</span><span>${lead.score}</span>
      </div>
      <div class="lead-info" data-action="detalhes">
        <h3>${escapeHtml(lead.empresa)}</h3>
        <div class="lead-meta">
          ${lead.segmento ? `<span class="tag">${escapeHtml(lead.segmento)}</span>` : ''}
          ${lead.cidade ? `<span class="tag">📍 ${escapeHtml(lead.cidade)}</span>` : ''}
          <span class="tag">${lead.temSite ? '🌐 tem site' : '🚫 sem site'}</span>
          <span class="badge status-${lead.status}">${statusLabel}</span>
        </div>
      </div>
      <div class="lead-actions">
        ${lead.telefone ? `<button class="btn-call" data-action="ligar">📞 Ligar</button>` : ''}
        ${lead.whatsapp ? `<button class="btn-wa" data-action="whatsapp">💬 WhatsApp</button>` : ''}
        <button data-action="detalhes">Detalhes</button>
      </div>
    </article>`;
}

function renderLeadsList() {
  const container = document.getElementById('leadsList');
  const empty = document.getElementById('emptyState');

  if (!state.leads.length) {
    container.innerHTML = '';
    empty.textContent = 'Nenhum lead por aqui ainda. Cadastre o primeiro lead para começar a priorizar sua prospecção.';
    empty.hidden = false;
    return;
  }
  const lista = leadsFiltrados();
  if (!lista.length) {
    container.innerHTML = '';
    empty.textContent = 'Nenhum lead encontrado com esses filtros.';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  container.innerHTML = lista.map(renderLeadCard).join('');
}

function renderAll() {
  atualizarStats();
  atualizarFiltroSegmento();
  renderLeadsList();
}

/* ---------- Detalhes do lead ---------- */

function abrirDetalhes(id) {
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;
  state.leadAtualId = id;
  document.getElementById('detalhesTitulo').textContent = lead.empresa;

  const rows = [
    ['Score JFX', `${lead.score}/100 · ${{ quente: '🔥 Quente', morno: '🟡 Morno', frio: '🧊 Frio' }[lead.temperatura]}`],
    ['Status', STATUS_LABELS[lead.status]],
    ['Segmento', lead.segmento || '—'],
    ['Responsável', lead.responsavel || '—'],
    ['Telefone', lead.telefone || '—'],
    ['WhatsApp', lead.whatsapp || '—'],
    ['E-mail', lead.email || '—'],
    ['Endereço', [lead.endereco, lead.cidade].filter(Boolean).join(', ') || '—'],
    ['Instagram', lead.instagram || '—'],
    ['Site', lead.temSite ? (lead.site || 'possui, sem URL informada') : 'Sem site'],
    ['Google Meu Negócio', `${lead.gmbAvaliacoes} avaliações · nota ${lead.gmbNota}`],
    ['Potencial de venda', POTENCIAL_LABELS[lead.potencialVenda]],
    ['Valor estimado', formatCurrency(lead.valorEstimado)],
    ['Primeiro contato', formatDate(lead.dataPrimeiroContato)],
    ['Último contato', formatDate(lead.ultimoContato)],
    ['Próximo follow-up', formatDate(lead.proximoFollowup)],
  ];

  document.getElementById('detalhesConteudo').innerHTML =
    rows.map(([k, v]) => `<div class="d-row"><span>${k}</span><span>${escapeHtml(String(v))}</span></div>`).join('') +
    (lead.observacoes ? `<div class="d-notes">${escapeHtml(lead.observacoes)}</div>` : '');

  abrirModal('modalDetalhes');
}

/* ---------- Formulário (novo / editar) ---------- */

function abrirFormNovo() {
  document.getElementById('modalLeadTitle').textContent = 'Novo lead';
  const form = document.getElementById('leadForm');
  form.reset();
  document.getElementById('leadId').value = '';
  abrirModal('modalLead');
}

function abrirFormEdicao(lead) {
  document.getElementById('modalLeadTitle').textContent = 'Editar lead';
  const form = document.getElementById('leadForm');
  form.reset();
  document.getElementById('leadId').value = lead.id;
  for (const [key, val] of Object.entries(lead)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
  }
  abrirModal('modalLead');
}

async function salvarLeadDoFormulario(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const idExistente = fd.get('id');
  const isNew = !idExistente;
  const id = idExistente || uuid();
  const anterior = state.leads.find((l) => l.id === id);

  const raw = {
    id,
    empresa: fd.get('empresa')?.trim(),
    segmento: fd.get('segmento')?.trim(),
    responsavel: fd.get('responsavel')?.trim(),
    telefone: fd.get('telefone')?.trim(),
    whatsapp: fd.get('whatsapp')?.trim(),
    email: fd.get('email')?.trim(),
    endereco: fd.get('endereco')?.trim(),
    cidade: fd.get('cidade')?.trim(),
    instagram: fd.get('instagram')?.trim(),
    instagramAtivo: fd.get('instagramAtivo') === 'on',
    site: fd.get('site')?.trim(),
    temSite: fd.get('temSite') === 'on',
    qualidadeSite: fd.get('qualidadeSite'),
    precisaManutencao: fd.get('precisaManutencao') === 'on',
    gmbAvaliacoes: fd.get('gmbAvaliacoes'),
    gmbNota: fd.get('gmbNota'),
    observacoes: fd.get('observacoes')?.trim(),
    dataPrimeiroContato: fd.get('dataPrimeiroContato'),
    ultimoContato: fd.get('ultimoContato'),
    proximoFollowup: fd.get('proximoFollowup'),
    status: fd.get('status'),
    potencialVenda: fd.get('potencialVenda'),
    valorEstimado: fd.get('valorEstimado'),
    criadoEm: anterior?.criadoEm || new Date().toISOString(),
  };

  if (!raw.empresa) { mostrarToast('Informe o nome da empresa.', 'error'); return; }

  const lead = normalizarLead(raw);
  const idx = state.leads.findIndex((l) => l.id === id);
  if (idx >= 0) state.leads[idx] = lead; else state.leads.unshift(lead);
  salvarCache(state.leads);
  renderAll();
  fecharModal('modalLead');

  try {
    if (isNew) await API.create(lead); else await API.update(lead);
    mostrarToast('Lead salvo e sincronizado com o Google Sheets.', 'success');
  } catch (err) {
    console.error(err);
    mostrarToast('Lead salvo neste navegador, mas ainda não sincronizou com o Google Sheets.', 'error');
  }
}

async function excluirLeadAtual() {
  const id = state.leadAtualId;
  if (!id) return;
  if (!confirm('Excluir este lead definitivamente? Essa ação não pode ser desfeita.')) return;
  state.leads = state.leads.filter((l) => l.id !== id);
  salvarCache(state.leads);
  renderAll();
  fecharModal('modalDetalhes');
  try {
    await API.remove(id);
    mostrarToast('Lead excluído e sincronizado.', 'success');
  } catch (err) {
    mostrarToast('Lead excluído neste navegador, mas ainda não sincronizou.', 'error');
  }
}

async function mudarStatusLeadAtual(novoStatus) {
  const id = state.leadAtualId;
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;
  lead.status = novoStatus;
  lead.ultimoContato = new Date().toISOString().slice(0, 10);
  salvarCache(state.leads);
  renderAll();
  fecharModal('modalDetalhes');
  try {
    await API.update(lead);
    mostrarToast('Status atualizado e sincronizado.', 'success');
  } catch (err) {
    mostrarToast('Status atualizado neste navegador, mas ainda não sincronizou.', 'error');
  }
}

/* ---------- Configuração (URL do Apps Script) ---------- */

async function salvarConfig() {
  const url = document.getElementById('apiUrlInput').value.trim();
  const hint = document.getElementById('configHint');
  if (!url) { hint.textContent = 'Cole a URL do Web App antes de salvar.'; hint.className = 'config-hint error'; return; }
  state.apiUrl = url;
  localStorage.setItem('jfxApiUrl', url);
  hint.textContent = '';
  fecharModal('modalConfig');
  await sincronizar();
}

/* ---------- Eventos ---------- */

function bindEvents() {
  document.getElementById('btnNovoLead').addEventListener('click', abrirFormNovo);
  document.getElementById('leadForm').addEventListener('submit', salvarLeadDoFormulario);

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => fecharModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
  });

  document.getElementById('leadsList').addEventListener('click', (e) => {
    const card = e.target.closest('.lead-card');
    if (!card) return;
    const action = e.target.closest('[data-action]')?.dataset.action;
    const lead = state.leads.find((l) => l.id === card.dataset.id);
    if (!lead) return;
    if (action === 'ligar') window.location.href = `tel:${lead.telefone.replace(/\D/g, '')}`;
    else if (action === 'whatsapp') window.open(waLink(lead.whatsapp), '_blank');
    else if (action === 'detalhes') abrirDetalhes(lead.id);
  });

  document.getElementById('btnEditarLead').addEventListener('click', () => {
    const lead = state.leads.find((l) => l.id === state.leadAtualId);
    fecharModal('modalDetalhes');
    if (lead) abrirFormEdicao(lead);
  });
  document.getElementById('btnExcluirLead').addEventListener('click', excluirLeadAtual);
  document.getElementById('btnDescartarLead').addEventListener('click', () => mudarStatusLeadAtual('descartado'));
  document.getElementById('btnConverterLead').addEventListener('click', () => mudarStatusLeadAtual('convertido'));

  document.getElementById('btnConfig').addEventListener('click', () => {
    document.getElementById('apiUrlInput').value = state.apiUrl;
    document.getElementById('configHint').textContent = '';
    abrirModal('modalConfig');
  });
  document.getElementById('btnSalvarConfig').addEventListener('click', salvarConfig);
  document.getElementById('syncStatus').addEventListener('click', sincronizar);

  document.getElementById('searchInput').addEventListener('input', debounce(renderLeadsList, 200));
  ['filterStatus', 'filterTemperatura', 'filterSegmento', 'sortBy'].forEach((id) => {
    document.getElementById(id).addEventListener('change', renderLeadsList);
  });
  document.getElementById('btnLimparFiltros').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('filterStatus').value = '';
    document.getElementById('filterTemperatura').value = '';
    document.getElementById('filterSegmento').value = '';
    document.getElementById('sortBy').value = 'score';
    state.quickFilter = null;
    document.querySelectorAll('.stat-card').forEach((c) => c.classList.remove('active'));
    renderLeadsList();
  });

  document.querySelectorAll('.stat-card').forEach((card) => {
    card.addEventListener('click', () => {
      const f = card.dataset.filter;
      state.quickFilter = state.quickFilter === f ? null : f;
      document.querySelectorAll('.stat-card').forEach((c) => c.classList.toggle('active', c.dataset.filter === state.quickFilter));
      renderLeadsList();
    });
  });
}

/* ---------- Inicialização ---------- */

async function init() {
  bindEvents();
  state.leads = carregarCache();
  renderAll();

  if (!state.apiUrl) {
    setSyncStatus('error', 'Não conectado');
    mostrarToast('Configure a conexão com o Google Sheets para começar a sincronizar seus leads.', 'error');
    abrirModal('modalConfig');
    return;
  }
  await sincronizar();
}

document.addEventListener('DOMContentLoaded', init);
