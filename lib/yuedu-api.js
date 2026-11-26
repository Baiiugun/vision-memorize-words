import { verifyImportCards } from './card-presentation.js';
import { SUPABASE_URL, ANON_KEY, BUCKET } from './config.js';
import { mergeImport } from './library-rules.js';
import { MAP_SCHEMA, mapPreview, mapImport } from './map-api.js';
import { MANAGEMENT_SCHEMA, getManagedTeachingState, studentManagementActions, teacherManagementActions } from './teaching-management-api.js';
import { applyTeachingFieldEdits } from './teaching-card-data.js';

// ---------- 学生 ----------
async function rpc(name, body, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + (token || ANON_KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).message || ''; } catch (e) { /* 忽略 */ }
    const err = new Error(msg || ('HTTP ' + res.status)); err.status = res.status; throw err;
  }
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
const pick = (c) => ({ type: c.type, queue: c.queue, due: c.due, ivl: c.ivl, factor: c.factor, reps: c.reps, lapses: c.lapses, lft: c.lft });
export const stateOf = pick;
// 函数返回的一行：[card_key, paper_id, section_id, ord, data, type, queue, due, ivl, factor, reps, lapses, lft, suspended]
const rowToCard = (r) => ({ key: r[0], paper: r[1], sec: r[2], ord: r[3], d: applyTeachingFieldEdits(r[4] || {}), type: r[5], queue: r[6], due: Number(r[7]), ivl: r[8], factor: r[9], reps: r[10], lapses: r[11], lft: r[12], suspended: !!r[13], flag: r[14] || 0, deleted: !!r[15] });
export const toState = (r) => ({ managed: r.management_schema === MANAGEMENT_SCHEMA, review: r.review || [], learner: r.learner, nowMs: r.now_ms, today: r.today, todayLog: r.today_log || [], papers: r.papers || [], cards: (r.cards || []).map(rowToCard) });

export function createStudentApi(code) {
  return {
    getState: async () => toState(await getManagedTeachingState(code)),
    answer: (key, state, log) => rpc('vision_student_answer', { p_code: code, p_card_key: key, p_state: pick(state), p_log: log }),
    undo: (key, prev, uid) => rpc('vision_student_undo', { p_code: code, p_card_key: key, p_prev: pick(prev), p_uid: uid }),
    ...studentManagementActions(code),
  };
}

// ---------- 老师 ----------
async function call(token, method, path, body, extra = {}) {
  const res = await fetch(SUPABASE_URL + path, { method, headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + (token || ANON_KEY), 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const problem = await res.json().catch(() => null);
    const error = new Error(problem?.message || `HTTP ${res.status}`);
    error.status = res.status; error.code = problem?.code;
    throw error;
  }
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
async function getAll(token, path) {   // PostgREST 一次最多 1000 行，分页取
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await call(token, 'GET', path, undefined, { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' });
    out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

// Keep the original package identity stable across revisions, scoped to the uploading teacher.
async function scopedId(prefix, teacher, original) {
  const bytes = new TextEncoder().encode(teacher + '\n' + original);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return prefix + Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function scopeImport(plan, owner, paperId, existingCards) {
  const scoped = structuredClone(plan);
  scoped.paper.paper_id = paperId;
  const oldGuids = new Map(existingCards.filter((card) => card.data?.guid).map((card) => [card.data.guid, card]));
  const keyMap = new Map();
  for (let index = 0; index < scoped.cards.length; index += 200) {
    await Promise.all(scoped.cards.slice(index, index + 200).map(async (card) => {
      const previous = oldGuids.get(card.data.guid);
      const original = card.card_key;
      card.card_key = previous?.card_key || await scopedId('yd:', owner, paperId + '\n' + original);
      card.paper_id = paperId;
      card.data.media_owner = owner;
      keyMap.set(original, card.card_key);
    }));
  }
  for (const link of scoped.relationships || []) {
    link.paper_id = paperId;
    const key = keyMap.get(link.card_key);
    if (!key) throw new Error('MAP 来源与待导入的词卡不匹配。');
    link.card_key = key;
  }
  return scoped;
}

export function createTeacherApi(token) {
  // UNIFIED-TEACHING-LIBRARY-V1: all teaching materials share one teacher page.
  let papersLoaded = false; const mapPaperIds = new Set();
  let owner;
  async function requirePrivateLibrary() {
    if (owner) return owner;
    const instruction = '请管理员在学校教学库首次安装最新版 03；已经安装过旧版 03 时请运行 04 升级词库隔离。';
    try {
      const status = await call(token, 'POST', '/rest/v1/rpc/vision_library_capabilities', {});
      if (!status?.private_banks || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(status.teacher_id)) {
        throw new Error(instruction);
      }
      owner = status.teacher_id.toLowerCase();
      return owner;
    } catch (error) {
      if (error.status === 404 || error.code === 'PGRST202' || error.message === instruction) {
        throw Object.assign(new Error(instruction), { code: 'PRIVATE_LIBRARY_REQUIRED' });
      }
      throw error;
    }
  }
  const api = {
    requirePrivateLibrary,
    ...teacherManagementActions(token, toState),
    listLearners: () => getAll(token, '/rest/v1/anki_test_learners?select=*&order=created_at'),
    // 教学学生默认可管理自己的卡片；老师可在学习管理中单独关闭。
    addLearner: (name, code) => call(token, 'POST', '/rest/v1/anki_test_learners', { name, code, kind: 'yuedu', self_manage: true }, { Prefer: 'return=minimal' }),
    updateLearner: (id, patch) => call(token, 'PATCH', `/rest/v1/anki_test_learners?id=eq.${id}`, patch, { Prefer: 'return=minimal' }),
    // 有没有答题记录（有的学生只能“停用”，不能“删除”）
    hasRecords: async (id) => (await call(token, 'GET', `/rest/v1/anki_test_revlog?learner_id=eq.${id}&select=uid&limit=1`)).length > 0,
    // 永久删除学生（数据库连带删掉进度、答题记录、布置）。页面只对“没有答题记录”的学生开放
    async deleteLearner(id) { const rows = await call(token, 'DELETE', `/rest/v1/anki_test_learners?id=eq.${id}`, undefined, { Prefer: 'return=representation' }); return rows.length; },
    async listPapers() {
      await requirePrivateLibrary();
      const papers = await getAll(token, '/rest/v1/anki_test_bank_papers?select=teacher_id,paper_id,bank,name,sort,sections,source,updated_at&order=sort,name');
      mapPaperIds.clear(); papers.filter((p) => p.source?.map_schema === MAP_SCHEMA).forEach((p) => mapPaperIds.add(p.paper_id)); papersLoaded = true; return papers;
    },
    async listAssignments(id) {
      const rows = await getAll(token, '/rest/v1/anki_test_assignments?select=learner_id,paper_id,section_id,assigned_at' + (id ? '&learner_id=eq.' + id : ''));
      if (!papersLoaded && rows.length) await api.listPapers();
      if (!rows.some((r) => mapPaperIds.has(r.paper_id))) return rows;
      const links = await getAll(token, '/rest/v1/anki_test_map_assignment_words?select=learner_id,paper_id,section_id,card_key' + (id ? '&learner_id=eq.' + id : ''));
      return rows.map((r) => mapPaperIds.has(r.paper_id) ? { ...r, card_keys: links.filter((x) => x.learner_id === r.learner_id && x.paper_id === r.paper_id && x.section_id === r.section_id).map((x) => x.card_key) } : r);
    },
    assign: (id, paper, secs) => rpc('anki_test_teacher_assign', { p_learner: id, p_paper: paper, p_sections: secs }, token),
    async unassign(id, paper, secs) {
      if (!papersLoaded) await api.listPapers();
      return rpc(mapPaperIds.has(paper) ? 'anki_test_map_unassign' : 'anki_test_teacher_unassign', { p_learner: id, p_paper: paper, p_sections: secs }, token);
    },
    getCards: (id) => getAll(token, `/rest/v1/anki_test_card_state?learner_id=eq.${id}&card_key=like.yd:*&select=card_key,type,queue,due,ivl,factor,reps,lapses,lft,suspended,flag,deleted,updated_at`),
    getBankCards: (paperIds) => (paperIds.length ? getAll(token, `/rest/v1/anki_test_bank_cards?paper_id=in.(${paperIds.map(encodeURIComponent).join(',')})&select=card_key,paper_id,section_id,ord,data&order=ord`) : Promise.resolve([])),
    getMapSources: (ids) => ids.length ? getAll(token, '/rest/v1/anki_test_map_word_sources?paper_id=in.(' + ids.map(encodeURIComponent).join(',') + ')&select=paper_id,section_id,card_key') : Promise.resolve([]),
    async getLibraryCards(ids) {
      const rows = await api.getBankCards(ids), mapIds = [...new Set(rows.filter((c) => c.data?.map_schema === MAP_SCHEMA).map((c) => c.paper_id))];
      if (!mapIds.length) return rows;
      const sources = await api.getMapSources(mapIds);
      return rows.map((c) => c.data?.map_schema === MAP_SCHEMA ? { ...c, source_sections: [...new Set(sources.filter((s) => s.paper_id === c.paper_id && s.card_key === c.card_key).map((s) => s.section_id))] } : c);
    },
    async getBankCardsByKeys(keys) {
      const ids = [...new Set(keys)], rows = [];
      for (let i = 0; i < ids.length; i += 100) rows.push(...await getAll(token, `/rest/v1/anki_test_bank_cards?card_key=in.(${ids.slice(i, i + 100).map(encodeURIComponent).join(',')})&select=card_key,paper_id,section_id,ord,data&order=ord`));
      return rows;
    },
    async setSuspended(id, keys, flag) {
      for (let i = 0; i < keys.length; i += 100) await call(token, 'PATCH', `/rest/v1/anki_test_card_state?learner_id=eq.${id}&card_key=in.(${keys.slice(i, i + 100).join(',')})`, { suspended: !!flag, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
      return keys.length;
    },
    dailyStats: (id, days = 14) => call(token, 'POST', '/rest/v1/rpc/anki_test_teacher_daily_stats', { p_learner: id, p_days: days }),
    saveMetadata: (paper, source) => call(token, 'PATCH', `/rest/v1/anki_test_bank_papers?paper_id=eq.${encodeURIComponent(paper)}`, { source, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' }),
    async previewImport(plan, targetId, targetSectionId) {
      verifyImportCards(plan.cards);
      const owner = await requirePrivateLibrary();
      const papers = (await api.listPapers()).filter((paper) => paper.teacher_id === owner);
      const rawId = plan.paper.paper_id;
      const newId = await scopedId('teach:', owner, rawId);
      const automatic = !targetId || targetId === rawId || targetId === newId;
      const existing = automatic
        ? papers.find((p) => p.paper_id === newId) || papers.find((p) => p.paper_id === rawId)
        : papers.find((p) => p.paper_id === targetId);
      if (!automatic && !existing) throw new Error('选定的材料不在你的词库中，请重新选择。');
      if (plan.paper.source?.map_schema === MAP_SCHEMA && !automatic) throw new Error('MAP 词包不能并入其他材料。');
      const paperId = existing?.paper_id || newId;
      const old = existing ? await api.getBankCards([paperId]) : [];
      plan = await scopeImport(plan, owner, paperId, old);
      verifyImportCards(plan.cards);
      if (plan.paper.source?.map_schema === MAP_SCHEMA) return mapPreview(token, api, plan, paperId, targetSectionId);
      if (existing) {
        const guids = new Map(old.filter((c) => c.data.guid).map((c) => [c.data.guid, c]));
        for (const c of plan.cards) {
          const prev = guids.get(c.data.guid);
          if (prev) { c.card_key = prev.card_key; c.section_id = prev.section_id; }
        }
        // An explicit legacy target may have older section IDs. Reuse a matching label only.
        const incoming = plan.paper.sections[0];
        if (targetSectionId && !existing.sections.some((s) => s.id === targetSectionId)) throw new Error('选定的篇章已变化，请重新校验');
        const previous = existing.sections.find((s) => s.id === incoming.id || s.label === incoming.label || s.board === incoming.board && s.piece === incoming.piece);
        const reused = new Set(plan.cards.filter((c) => guids.has(c.data.guid)).map((c) => c.section_id));
        if (reused.size > 1) throw new Error('此包跨越多个已有篇章，请按篇章分别导入');
        const sid = targetSectionId || previous?.id || [...reused][0] || incoming.id;
        if (reused.size && !reused.has(sid)) throw new Error('选定篇章与原有词卡的来源不一致，不会移动已有卡片');
        plan.paper.sections[0].id = sid; plan.cards.forEach((c) => { c.section_id = sid; });
      }
      return mergeImport(existing, old, plan);
    },
    async importPrepared(preview, media, onProgress = () => {}) {
      verifyImportCards(preview.rows);
      const owner = await requirePrivateLibrary();
      if (preview.map) return mapImport(token, preview, media, onProgress, owner);
      for (let i = 0; i < media.length; i++) {
        const m = media[i]; onProgress(`上传读音 ${i + 1}/${media.length}`);
        const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/yuedu/${owner}/${encodeURIComponent(m.name)}`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': m.blob.type || 'audio/mpeg', 'x-upsert': 'true' }, body: m.blob });
        if (!r.ok) throw new Error(`读音上传失败（${r.status}），可以重新导入重试`);
      }
      const { paper, rows } = preview, now = new Date().toISOString();
      // Upserts only. No student progress or assignment table is touched during import.
      await call(token, 'POST', '/rest/v1/anki_test_bank_papers?on_conflict=paper_id', { ...paper, updated_at: now }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      for (let i = 0; i < rows.length; i += 100) {
        onProgress(`保存词卡 ${Math.min(rows.length, i + 100)}/${rows.length}`);
        await call(token, 'POST', '/rest/v1/anki_test_bank_cards?on_conflict=card_key', rows.slice(i, i + 100).map((c) => ({ ...c, updated_at: now })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
      }
    },
    async assignSelection(id, selected) {
      if (!selected.length) throw new Error('请先选择词卡');
      const learner = (await api.listLearners()).find((l) => l.id === id);
      if (learner?.kind !== 'yuedu' || learner.status === 'paused') throw new Error('只能给启用中的学生版学习者布置');
      const pids = [...new Set(selected.map((c) => c.paper_id))];
      const allowed = new Map((await api.getBankCards(pids)).map((c) => [c.card_key, c]));
      if (selected.some((c) => !allowed.has(c.card_key) || allowed.get(c.card_key).paper_id !== c.paper_id)) throw new Error('词库已变化，请重新选择');
      const mapRows = selected.filter((c) => allowed.get(c.card_key).data?.map_schema === MAP_SCHEMA);
      const normalRows = selected.filter((c) => allowed.get(c.card_key).data?.map_schema !== MAP_SCHEMA);
      const mapGroups = new Map(), sources = await api.getMapSources([...new Set(mapRows.map((c) => c.paper_id))]);
      const sourceKeys = new Set(sources.map((s) => s.paper_id + '|' + s.section_id + '|' + s.card_key));
      for (const c of mapRows) {
        if (!Array.isArray(c.selected_sections) || !c.selected_sections.length) throw new Error('请按MAP练习重新选词，缺少Quiz出处');
        const group = mapGroups.get(c.paper_id) || new Map();
        for (const section_id of new Set(c.selected_sections)) {
          if (!sourceKeys.has(c.paper_id + '|' + section_id + '|' + c.card_key)) throw new Error('MAP出处已变化，请重新选词');
          group.set(section_id + '|' + c.card_key, { section_id, card_key: c.card_key });
        }
        mapGroups.set(c.paper_id, group);
      }
      const old = await api.getCards(id), keys = new Set(old.map((c) => c.card_key));
      const addedCount = new Set(selected.filter((c) => !keys.has(c.card_key)).map((c) => c.card_key)).size;
      for (const [paper, links] of mapGroups) await rpc('anki_test_map_assign', { p_learner: id, p_paper: paper, p_selection: [...links.values()] }, token);
      if (!normalRows.length) return addedCount;
      const current = mapGroups.size ? await api.getCards(id) : old;
      let base = Math.max(-1, ...current.filter((c) => c.queue === 0).map((c) => c.due));
      const added = [...new Set(normalRows.map((c) => c.card_key))].filter((k) => !keys.has(k)).map((k) => ({ learner_id: id, card_key: k, type: 0, queue: 0, due: ++base, ivl: 0, factor: 0, reps: 0, lapses: 0, lft: 0, suspended: false }));
      for (let i = 0; i < added.length; i += 100) await call(token, 'POST', '/rest/v1/anki_test_card_state?on_conflict=learner_id,card_key', added.slice(i, i + 100), { Prefer: 'resolution=ignore-duplicates,return=minimal' });
      const pairs = new Map(normalRows.map((c) => { const b = allowed.get(c.card_key); return [b.paper_id + '|' + b.section_id, { learner_id: id, paper_id: b.paper_id, section_id: b.section_id }]; }));
      await call(token, 'POST', '/rest/v1/anki_test_assignments?on_conflict=learner_id,paper_id,section_id', [...pairs.values()], { Prefer: 'resolution=ignore-duplicates,return=minimal' });
      return addedCount;
    },
  };
  return api;
}

// ======================================================================================
