/* ============ 佩剑训练手账 v4 核心逻辑 ============ */
/* v4: 照片存 IndexedDB（大容量），localStorage 只存纯文字（永不超限） */
(() => {
  'use strict';

  // ---------- 工具 ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2500);
  }
  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) {
    try { localStorage.setItem(k, v); return true; }
    catch (e) { console.error('[storageSet] fail', k, e.name); return false; }
  }
  function storageDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // ---------- IndexedDB 照片存储 ----------
  let _db = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open('saber_journal_db', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }
  async function dbPutPhoto(id, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put({ id, blob });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbGetPhoto(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDeletePhoto(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }
  // Blob -> Object URL (for <img src>)
  function blobToURL(blob) {
    return URL.createObjectURL(blob);
  }
  // Blob -> dataURL (for canvas drawImage / AI upload)
  function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  // ---------- 标签 ----------
  const TAGS = {
    footwork: { label: '步伐',     icon: '🦶' },
    attack:   { label: '进攻/时机', icon: '⚡' },
    defense:  { label: '防守',     icon: '🛡' },
    mind:     { label: '心态',     icon: '🧠' },
    skill:    { label: '要领/口诀', icon: '📌' },
  };
  function tagLabel(key) {
    const t = TAGS[key];
    return t ? (t.icon + ' ' + t.label) : (key || '');
  }

  // ---------- 状态 ----------
  let entries = [];
  let currentTag = 'footwork';
  let photos = [];   // [{ id, url(临时ObjectURL) }]
  let currentFilter = 'all';
  let generating = null;

  const STORE_KEY = 'saber_journal_entries_v4';

  // ---------- 初始化 ----------
  async function init() {
    // 清理旧 Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister());
      }).catch(() => {});
    }
    // 迁移旧数据（如果有）
    migrateOldEntries();
    loadEntries();
    console.log('[init] entries:', entries.length);
    bindEvents();
    $('#session-date').value = todayInput();
    renderPhotos();
    renderReview();
    setupReminder();
    maybeShowWeekly();
    updateStats();
  }

  // 迁移 v3 旧数据（localStorage key 不同）
  function migrateOldEntries() {
    const oldKey = 'saber_journal_entries';
    const oldRaw = storageGet(oldKey);
    if (!oldRaw) return;
    try {
      const oldEntries = JSON.parse(oldRaw);
      if (!Array.isArray(oldEntries) || !oldEntries.length) return;
      // 旧数据中的 photos 是 [{ dataUrl }]，迁移到 IndexedDB
      (async () => {
        for (const e of oldEntries) {
          if (e.photos && e.photos.length) {
            const newPhotoIds = [];
            for (const p of e.photos) {
              if (p.dataUrl) {
                const pid = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
                // dataUrl -> Blob -> IndexedDB
                try {
                  const resp = await fetch(p.dataUrl);
                  const blob = await resp.blob();
                  await dbPutPhoto(pid, blob);
                  newPhotoIds.push(pid);
                } catch (err) { console.error('[migrate] photo fail', err); }
              }
            }
            e.photos = newPhotoIds; // 只存 ID
          }
        }
        entries = oldEntries;
        const ok = storageSet(STORE_KEY, JSON.stringify(entries));
        if (ok) {
          storageDel(oldKey);
          console.log('[migrate] done, migrated', oldEntries.length, 'entries');
          renderReview();
          updateStats();
        }
      })();
    } catch (e) { console.error('[migrate] fail', e); }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $$('.tag-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTag = btn.dataset.tag;
        $$('.tag-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    $('#coach-input').addEventListener('input', () => {
      let v = $('#coach-input').value;
      if (v.length > 500) { v = v.slice(0, 500); $('#coach-input').value = v; }
      $('#coach-count').textContent = v.length + ' / 500';
    });
    $('#mind-input').addEventListener('input', () => {
      let v = $('#mind-input').value;
      if (v.length > 500) { v = v.slice(0, 500); $('#mind-input').value = v; }
      $('#mind-count').textContent = v.length + ' / 500';
    });

    const fileInput = $('#file-input');
    $('#photo-zone').addEventListener('click', e => {
      if (e.target.closest('.del') || e.target.closest('.add-more')) return;
      fileInput.click();
    });
    fileInput.addEventListener('change', e => {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    $('#btn-ai').addEventListener('click', handleAI);
    $('#btn-save-entry').addEventListener('click', handleSaveEntry);
    $('#btn-review').addEventListener('click', goReview);
    $('#btn-back-edit').addEventListener('click', goEdit);
    $('#btn-make-card').addEventListener('click', handleMakeCard);
    $('#btn-save').addEventListener('click', handleSave);
    $('#btn-delete').addEventListener('click', handleDelete);
    $('#btn-back').addEventListener('click', () => {
      $('#screen-preview').classList.remove('active');
      $('#screen-review').classList.add('active');
    });

    $$('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderReview();
      });
    });

    $('#btn-settings').addEventListener('click', openSettings);
    $('#modal-close').addEventListener('click', closeSettings);
    $('#btn-save-settings').addEventListener('click', saveSettings);
    $('#settings-modal').addEventListener('click', e => { if (e.target === $('#settings-modal')) closeSettings(); });
    $('#btn-enable-remind').addEventListener('click', enableReminder);
    $('#btn-disable-remind').addEventListener('click', disableReminder);
  }

  // ---------- 数据 ----------
  function loadEntries() {
    try {
      entries = JSON.parse(storageGet(STORE_KEY) || '[]');
      if (!Array.isArray(entries)) entries = [];
    } catch (e) { entries = []; }
  }
  function saveEntries() {
    // entries 中 photos 只存 ID 数组，不含 base64，localStorage 不会超限
    const ok = storageSet(STORE_KEY, JSON.stringify(entries));
    if (!ok) console.error('[saveEntries] localStorage write failed');
    return ok;
  }

  // ---------- 图片处理 ----------
  // 压缩图片到最长边 1200px，输出 JPEG blob
  function compressToBlob(dataUrl, maxSide) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w > h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        c.toBlob(blob => resolve(blob), 'image/jpeg', 0.82);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function handleFiles(list) {
    if (!list || !list.length) return;
    let count = 0;
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        // file -> dataUrl (用于压缩) -> blob (存 IndexedDB)
        const dataUrl = await new Promise(res => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => res(null);
          reader.readAsDataURL(file);
        });
        if (!dataUrl) continue;
        const blob = await compressToBlob(dataUrl, 1200);
        if (!blob) continue;
        const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
        await dbPutPhoto(id, blob);
        const url = URL.createObjectURL(blob);
        photos.push({ id, url });
        if (photos.length > 9) {
          // 删除多余的照片
          const removed = photos.shift();
          if (removed && removed.url) URL.revokeObjectURL(removed.url);
          await dbDeletePhoto(removed.id).catch(() => {});
        }
        count++;
      } catch (err) {
        console.error('[handleFiles] error', err);
      }
    }
    renderPhotos();
    if (count > 0) toast('已添加 ' + count + ' 张照片（共 ' + photos.length + ' 张）');
    else toast('未选择有效的图片');
  }

  function renderPhotos() {
    const zone = $('#photo-zone');
    const preview = $('#photo-preview');
    if (photos.length) {
      zone.classList.add('has-photo');
      let html = '<div class="photo-bar">';
      html += '<span class="photo-count">📷 ' + photos.length + ' / 9 张</span>';
      if (photos.length < 9) html += '<button class="add-more" id="add-more-btn">＋ 继续添加</button>';
      html += '</div>';
      html += '<div class="photo-grid">';
      html += photos.map(p => `
        <div class="thumb" data-id="${p.id}">
          <img src="${p.url}" alt="训练照片">
          <button class="del" data-id="${p.id}">✕</button>
        </div>`).join('');
      html += '</div>';
      preview.innerHTML = html;
      preview.querySelectorAll('.del').forEach(d => {
        d.addEventListener('click', ev => {
          ev.stopPropagation();
          const target = photos.find(p => p.id === d.dataset.id);
          if (target && target.url) URL.revokeObjectURL(target.url);
          photos = photos.filter(p => p.id !== d.dataset.id);
          dbDeletePhoto(d.dataset.id).catch(() => {});
          renderPhotos();
          if (photos.length === 0) toast('已清空，可重新选图');
        });
      });
      const addBtn = $('#add-more-btn');
      if (addBtn) addBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        $('#file-input').click();
      });
    } else {
      zone.classList.remove('has-photo');
      preview.innerHTML = '';
    }
  }

  // ---------- 保存记录 ----------
  function handleSaveEntry() {
    const coach = $('#coach-input').value.trim();
    const mind = $('#mind-input').value.trim();
    const title = $('#session-title').value.trim();
    const week = $('#session-week').value.trim();
    const date = $('#session-date').value;

    if (!coach && !mind) { toast('请至少填写一个要点或心得'); return; }
    if (!date) { toast('请选择训练日期'); return; }

    const entry = {
      id: 'e' + Date.now(),
      date,
      week,
      title,
      tag: currentTag,
      coach,
      mind,
      // 只存照片 ID，base64 数据在 IndexedDB
      photoIds: photos.map(p => p.id),
      time: Date.now(),
    };
    entries.unshift(entry);
    const ok = saveEntries();

    // 保存验证
    let verified = false;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const reloaded = raw ? JSON.parse(raw) : [];
      verified = Array.isArray(reloaded) && reloaded.some(e => e.id === entry.id);
      console.log('[handleSaveEntry] verified:', verified, 'total:', reloaded.length);
    } catch (e) {
      console.error('[handleSaveEntry] verify fail', e);
    }

    if (!verified) {
      entries = entries.filter(e => e.id !== entry.id);
      // 清理刚存到 IndexedDB 的照片
      photos.forEach(p => dbDeletePhoto(p.id).catch(() => {}));
      toast('⚠ 保存失败！请重试');
      return;
    }

    // 清空编辑区（照片 ObjectURL 需要保留，因为 photos 数组清空但 IndexedDB 中已存好）
    for (const p of photos) { if (p.url) URL.revokeObjectURL(p.url); }
    $('#coach-input').value = ''; $('#coach-count').textContent = '0 / 500';
    $('#mind-input').value = ''; $('#mind-count').textContent = '0 / 500';
    $('#session-title').value = '';
    $('#session-week').value = '';
    photos = [];
    renderPhotos();
    toast('训练记录已保存 ⚔️');
    updateStats();
    goReview();
  }

  // ---------- 屏切换 ----------
  function goReview() {
    $('#screen-edit').classList.remove('active');
    $('#screen-review').classList.add('active');
    renderReview();
    maybeShowWeekly();
    window.scrollTo(0, 0);
  }
  function goEdit() {
    $('#screen-review').classList.remove('active');
    $('#screen-edit').classList.add('active');
    updateStats();
    window.scrollTo(0, 0);
  }

  // ---------- 复习渲染 ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getFiltered() {
    if (currentFilter === 'all') return entries;
    return entries.filter(e => e.tag === currentFilter);
  }

  async function renderReview() {
    const list = $('#review-list');
    const empty = $('#empty-review');
    const filtered = getFiltered();
    if (!filtered.length) {
      empty.style.display = 'block';
      list.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    // 先渲染文字部分（不阻塞）
    list.innerHTML = filtered.map(e => {
      const photoCount = (e.photoIds && e.photoIds.length) || (e.photos && e.photos.length) || 0;
      return `
      <div class="review-item" data-id="${e.id}">
        <div class="ri-head">
          <span class="ri-date">${fmtDate(e.date)}${e.week ? ' · 第' + e.week + '周' : ''}</span>
          <div class="ri-badges"><span class="ri-badge">${tagLabel(e.tag)}</span></div>
        </div>
        ${e.title ? `<div class="ri-title">${escapeHtml(e.title)}</div>` : ''}
        <div class="ri-content">
          ${e.coach ? `<div class="sec"><span class="sec-label">🎓 老师要点：</span>${escapeHtml(e.coach)}</div>` : ''}
          ${e.mind ? `<div class="sec"><span class="sec-label">⚔ 实战心得：</span>${escapeHtml(e.mind)}</div>` : ''}
        </div>
        <div class="ri-photos" data-entry="${e.id}">${photoCount ? '<span style="font-size:12px;color:var(--ink-soft)">📷 ' + photoCount + ' 张照片加载中…</span>' : ''}</div>
      </div>`;
    }).join('');

    // 异步加载照片缩略图
    for (const e of filtered) {
      const ids = e.photoIds || (e.photos && e.photos.map(p => null).filter(() => false)) || [];
      // 兼容旧数据：如果有 photos 数组（含 dataUrl），直接用
      if (e.photos && e.photos.length && !e.photoIds) {
        const container = list.querySelector(`.ri-photos[data-entry="${e.id}"]`);
        if (container) container.innerHTML = e.photos.map(p => `<img src="${p.dataUrl}" alt="照片">`).join('');
        continue;
      }
      if (!ids.length) continue;
      const container = list.querySelector(`.ri-photos[data-entry="${e.id}"]`);
      if (!container) continue;
      const imgs = [];
      for (const pid of ids) {
        try {
          const blob = await dbGetPhoto(pid);
          if (blob) imgs.push(blobToURL(blob));
        } catch (err) {}
      }
      if (imgs.length) {
        container.innerHTML = imgs.map(u => `<img src="${u}" alt="照片">`).join('');
      } else {
        container.innerHTML = '';
      }
    }

    // 绑定点击事件
    list.querySelectorAll('.review-item').forEach(item => {
      item.addEventListener('click', () => previewEntry(item.dataset.id));
    });
  }

  // ---------- 本周回顾 ----------
  function getWeekEntries() {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day);
    monday.setHours(0, 0, 0, 0);
    return entries.filter(e => {
      const d = new Date(e.date + 'T00:00:00');
      return d >= monday;
    });
  }

  function updateStats() {
    const el = $('#stats-text');
    if (!el) return;
    if (!entries.length) { el.textContent = '还没有训练记录'; return; }
    const weekEntries = getWeekEntries();
    el.textContent = `共有 ${entries.length} 条训练记录${weekEntries.length ? '（本周 ' + weekEntries.length + ' 条）' : ''} → 点"进入复习"查看`;
  }

  function maybeShowWeekly() {
    const weekEntries = getWeekEntries();
    const card = $('#week-card');
    if (weekEntries.length) {
      card.style.display = 'block';
      $('#week-content').innerHTML = weekEntries.map(e => `
        <div>${fmtDate(e.date)} ${e.title ? '· ' + escapeHtml(e.title) : ''} ${tagLabel(e.tag)}</div>
      `).join('');
    } else {
      card.style.display = 'none';
    }
  }

  // ---------- 训练提醒 ----------
  function setupReminder() {
    const time = storageGet('saber_remind_time') || '19:00';
    $('#remind-time').value = time;
    updateRemindStatus();
    if (storageGet('saber_remind_enabled') === '1') checkReminderLoop();
  }
  function updateRemindStatus() {
    const enabled = storageGet('saber_remind_enabled') === '1';
    $('#remind-status').textContent = enabled
      ? '已开启，每天 ' + (storageGet('saber_remind_time') || '19:00') + ' 提醒复习本周要点'
      : '提醒未开启';
  }
  function enableReminder() {
    const time = $('#remind-time').value || '19:00';
    storageSet('saber_remind_time', time);
    storageSet('saber_remind_enabled', '1');
    updateRemindStatus();
    toast('提醒已开启 ✓');
    if ('Notification' in window) {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('⚔ 佩剑训练提醒已开启', { body: '训练前会提醒你复习要点', icon: 'icons/icon-192.png' });
        }
      });
    }
    checkReminderLoop();
  }
  function disableReminder() {
    storageSet('saber_remind_enabled', '0');
    updateRemindStatus();
    toast('提醒已关闭');
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  }
  let reminderTimer = null;
  function checkReminderLoop() {
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = setInterval(() => {
      if (storageGet('saber_remind_enabled') !== '1') return;
      const time = storageGet('saber_remind_time') || '19:00';
      const [h, m] = time.split(':').map(Number);
      const now = new Date();
      if (now.getHours() === h && now.getMinutes() === m) {
        const last = storageGet('saber_last_remind_date');
        const today = now.toDateString();
        if (last !== today) {
          storageSet('saber_last_remind_date', today);
          showReminder();
        }
      }
    }, 60000);
  }
  function showReminder() {
    const weekEntries = getWeekEntries();
    if (!weekEntries.length) return;
    const body = '本周已记录 ' + weekEntries.length + ' 条训练，训练前记得复习！';
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('⚔ 佩剑训练提醒', { body, icon: 'icons/icon-192.png' });
    }
    toast('⚔ 训练前记得复习本周要点！');
  }

  // ---------- AI 润色 ----------
  const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  const ARK_MODEL = 'doubao-1-5-vision-pro-32k-250115';

  function loadKey() { return (storageGet('ark_api_key') || '').trim(); }
  function openSettings() {
    $('#api-key').value = loadKey();
    $('#settings-modal').classList.add('show');
  }
  function closeSettings() { $('#settings-modal').classList.remove('show'); }
  function saveSettings() {
    const key = $('#api-key').value.trim();
    storageSet('ark_api_key', key);
    closeSettings();
    toast(key ? 'AI 设置已保存 ✓' : '已清除 AI 设置');
  }

  async function callAI(promptText) {
    const key = loadKey();
    if (!key) throw Object.assign(new Error('未设置AI Key'), { noKey: true });
    const content = [{ type: 'text', text: promptText }];
    // 从 IndexedDB 加载照片转 dataURL 发给 AI
    for (const p of photos) {
      const blob = await dbGetPhoto(p.id);
      if (blob) {
        const dataUrl = await blobToDataURL(blob);
        if (dataUrl) content.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }

    const resp = await fetch(ARK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: ARK_MODEL, messages: [{ role: 'user', content }], max_tokens: 800, temperature: 0.7 })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('AI 请求失败 (' + resp.status + ') ' + t.slice(0, 120));
    }
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  function buildAIPrompt(text, kind) {
    const kindLabel = kind === 'coach' ? '老师讲解的要点' : '我的实战心得';
    return `你是佩剑（击剑）训练助教。用户是一名佩剑爱好者，以下是他随手记的${kindLabel}。
请整理成一条清晰、可执行的训练笔记，供训练前复习。
要求：
1. 保留关键技术要点，用简洁的中文表达。
2. 如果像口诀，保留并适当润色。
3. 去掉口语废话，直接输出整理后的内容。
4. 不超过 150 字。

随手记：
${text || '（无）'}

直接输出整理后的内容，不要任何前言。`;
  }

  async function handleAI() {
    const coach = $('#coach-input').value.trim();
    const mind = $('#mind-input').value.trim();
    if (!loadKey()) { toast('请先在设置里填入 AI Key'); openSettings(); return; }
    if (!coach && !mind) { toast('请先写一些要点或心得'); return; }
    const btn = $('#btn-ai');
    btn.disabled = true; btn.textContent = 'AI 润色中…';
    try {
      if (coach) {
        const out = await callAI(buildAIPrompt(coach, 'coach'));
        $('#coach-input').value = out;
        $('#coach-count').textContent = out.length + ' / 500';
      }
      if (mind) {
        const out = await callAI(buildAIPrompt(mind, 'mind'));
        $('#mind-input').value = out;
        $('#mind-count').textContent = out.length + ' / 500';
      }
      toast('AI 润色完成 ✨');
    } catch (err) {
      console.error(err);
      if (err.noKey) { toast('请先在设置里填入 AI Key'); openSettings(); }
      else toast('AI 出错：' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = '✨ AI 润色';
    }
  }

  // ---------- 长图渲染 ----------
  const W = 750, PAD = 56, TOP = 180;

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片加载失败'));
      img.src = src;
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrap(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      if (!para) { out.push(''); continue; }
      let line = '';
      for (const ch of Array.from(para)) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
        else line += ch;
      }
      if (line) out.push(line);
    }
    return out;
  }

  // 测量一条记录在复习卡中的高度
  function measureEntry(ctx, e, cw) {
    const textW = cw - 40;
    let h = 16;
    h += 32; // 日期行
    if (e.title) h += 36;
    if (e.coach) { h += 6; h += wrap(ctx, '【老师要点】' + e.coach, textW).length * 30; }
    if (e.mind) { h += 6; h += wrap(ctx, '【实战心得】' + e.mind, textW).length * 30; }
    const photoCount = (e.photoIds && e.photoIds.length) || (e.photos && e.photos.length) || 0;
    if (photoCount) { h += 8; h += Math.min(Math.ceil(photoCount / 3), 2) * 108; }
    return h + 14;
  }

  // 从 IndexedDB 加载照片为 HTMLImageElement
  async function loadEntryPhotos(entry, maxCount) {
    const ids = entry.photoIds || [];
    // 兼容旧数据
    if (!ids.length && entry.photos && entry.photos.length) {
      const imgs = [];
      for (const p of entry.photos.slice(0, maxCount)) {
        if (p.dataUrl) { try { imgs.push(await loadImage(p.dataUrl)); } catch (e) {} }
      }
      return imgs;
    }
    const imgs = [];
    for (const pid of ids.slice(0, maxCount)) {
      try {
        const blob = await dbGetPhoto(pid);
        if (blob) {
          const url = URL.createObjectURL(blob);
          const img = await loadImage(url);
          imgs.push(img);
          // URL 会在页面关闭时自动释放
        }
      } catch (e) {}
    }
    return imgs;
  }

  // 汇总卡片（当前筛选）
  async function generateSummaryCard(items) {
    const tmp = document.createElement('canvas').getContext('2d');
    tmp.font = '28px "PingFang SC","Microsoft YaHei",sans-serif';
    const cw = W - PAD * 2;
    const textW = cw - 40;

    const itemsSlice = items.slice(0, 6);
    const heights = itemsSlice.map(e => measureEntry(tmp, e, cw));
    const bodyH = heights.reduce((s, h) => s + h + 14, 0);
    const H = PAD + TOP + bodyH + 90;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx2 = canvas.getContext('2d');

    const grad = ctx2.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0E1A2B'); grad.addColorStop(1, '#122A45');
    ctx2.fillStyle = grad; ctx2.fillRect(0, 0, W, H);

    ctx2.fillStyle = 'rgba(61,118,255,.15)';
    ctx2.beginPath(); ctx2.arc(W - 80, 30, 70, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = 'rgba(240,180,41,.12)';
    ctx2.beginPath(); ctx2.arc(80, 140, 50, 0, Math.PI * 2); ctx2.fill();

    ctx2.fillStyle = '#F0B429';
    ctx2.font = 'bold 44px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx2.textAlign = 'center';
    ctx2.fillText('⚔ 佩剑训练 · 复习卡片', W / 2, PAD + 60);
    ctx2.fillStyle = '#93A7C0';
    ctx2.font = '24px sans-serif';
    ctx2.fillText('筛选：' + (currentFilter === 'all' ? '全部' : tagLabel(currentFilter)), W / 2, PAD + 105);

    let y = PAD + TOP + 10;
    ctx2.textAlign = 'left';
    for (let i = 0; i < itemsSlice.length; i++) {
      const e = itemsSlice[i];
      const bh = heights[i];
      roundRect(ctx2, PAD, y, cw, bh, 14);
      ctx2.fillStyle = '#16263C'; ctx2.fill();
      let yy = y + 20;
      ctx2.font = '22px sans-serif'; ctx2.fillStyle = '#93A7C0';
      ctx2.fillText(fmtDate(e.date) + (e.week ? ' · 第' + e.week + '周' : '') + ' ' + tagLabel(e.tag), PAD + 18, yy);
      yy += 32;
      if (e.title) {
        ctx2.font = 'bold 28px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx2.fillStyle = '#EAF1FA';
        ctx2.fillText(e.title, PAD + 18, yy);
        yy += 36;
      }
      if (e.coach) {
        ctx2.font = '24px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx2.fillStyle = '#F0B429';
        ctx2.fillText('【老师要点】', PAD + 18, yy); yy += 30;
        ctx2.fillStyle = '#EAF1FA';
        const ls = wrap(ctx2, e.coach, textW);
        for (const l of ls) { ctx2.fillText(l, PAD + 18, yy); yy += 30; }
      }
      if (e.mind) {
        ctx2.font = '24px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx2.fillStyle = '#F0B429';
        ctx2.fillText('【实战心得】', PAD + 18, yy); yy += 30;
        ctx2.fillStyle = '#EAF1FA';
        const ls = wrap(ctx2, e.mind, textW);
        for (const l of ls) { ctx2.fillText(l, PAD + 18, yy); yy += 30; }
      }
      y += bh + 14;
    }

    ctx2.textAlign = 'right';
    ctx2.font = '24px "KaiTi","STKaiti",sans-serif';
    ctx2.fillStyle = '#93A7C0';
    ctx2.fillText('· 佩剑训练手账 ·', W - PAD, H - 28);

    return canvas.toDataURL('image/png');
  }

  // 单条记录卡（点击列表项生成）
  async function generateEntryCard(entry) {
    const tmp = document.createElement('canvas').getContext('2d');
    tmp.font = '28px "PingFang SC","Microsoft YaHei",sans-serif';
    const cw = W - PAD * 2;
    const textW = cw - 40;

    const sections = [];
    if (entry.title) sections.push({ text: entry.title, bold: true, color: '#EAF1FA', size: 28 });
    if (entry.coach) sections.push({ text: '【老师要点】' + entry.coach, bold: false, color: '#EAF1FA', size: 24 });
    if (entry.mind) sections.push({ text: '【实战心得】' + entry.mind, bold: false, color: '#EAF1FA', size: 24 });

    const imgs = await loadEntryPhotos(entry, 3);

    let bodyH = 0;
    for (const s of sections) {
      const ls = wrap(tmp, s.text, textW);
      bodyH += ls.length * (s.bold ? 32 : 30) + 10;
    }
    const photoH = imgs.length ? (Math.ceil(imgs.length / 3) * 110 + 10) : 0;
    const H = PAD + TOP + bodyH + photoH + 120;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx2 = canvas.getContext('2d');

    const grad = ctx2.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0E1A2B'); grad.addColorStop(1, '#122A45');
    ctx2.fillStyle = grad; ctx2.fillRect(0, 0, W, H);

    ctx2.fillStyle = 'rgba(61,118,255,.15)';
    ctx2.beginPath(); ctx2.arc(W - 80, 30, 70, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = 'rgba(240,180,41,.12)';
    ctx2.beginPath(); ctx2.arc(80, 140, 50, 0, Math.PI * 2); ctx2.fill();

    ctx2.fillStyle = '#F0B429';
    ctx2.font = 'bold 44px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx2.textAlign = 'center';
    ctx2.fillText('⚔ 佩剑训练 · 记录卡', W / 2, PAD + 60);
    ctx2.fillStyle = '#93A7C0';
    ctx2.font = '24px sans-serif';
    ctx2.fillText(fmtDate(entry.date) + (entry.week ? ' · 第' + entry.week + '周' : '') + ' ' + tagLabel(entry.tag), W / 2, PAD + 105);

    let y = PAD + TOP + 10;
    ctx2.textAlign = 'left';
    for (const s of sections) {
      ctx2.font = (s.bold ? 'bold ' : '') + s.size + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx2.fillStyle = s.color;
      const ls = wrap(ctx2, s.text, textW);
      for (const l of ls) { ctx2.fillText(l, PAD + 16, y); y += (s.bold ? 32 : 30); }
      y += 8;
    }
    if (imgs.length) {
      y += 6;
      const tw = cw - 16;
      const gap = 8;
      const step = (tw - gap * 2) / 3;
      for (let i = 0; i < imgs.length; i++) {
        const col = i % 3, row = Math.floor(i / 3);
        const x = PAD + 16 + col * (step + gap);
        const yy = y + row * 110;
        ctx2.save();
        roundRect(ctx2, x, yy, step, 100, 8); ctx2.clip();
        ctx2.drawImage(imgs[i], x, yy, step, 100);
        ctx2.restore();
      }
    }

    ctx2.textAlign = 'right';
    ctx2.font = '24px "KaiTi","STKaiti",sans-serif';
    ctx2.fillStyle = '#93A7C0';
    ctx2.fillText('· 佩剑训练手账 ·', W - PAD, H - 28);

    return canvas.toDataURL('image/png');
  }

  async function handleMakeCard() {
    const filtered = getFiltered();
    if (!filtered.length) { toast('当前筛选下没有记录'); return; }
    const btn = $('#btn-make-card');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const url = await generateSummaryCard(filtered);
      generating = { dataUrl: url };
      showPreview();
      toast('复习卡片已生成');
    } catch (err) {
      console.error(err);
      toast('生成失败：' + (err.message || err));
    } finally {
      btn.disabled = false; btn.textContent = '🖼 生成复习卡片';
    }
  }

  async function previewEntry(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    const btn = $('#btn-make-card');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const url = await generateEntryCard(e);
      generating = { dataUrl: url };
      showPreview();
    } catch (err) {
      console.error(err);
      toast('生成失败：' + (err.message || err));
    } finally {
      btn.disabled = false; btn.textContent = '🖼 生成复习卡片';
    }
  }

  function showPreview() {
    if (!generating || !generating.dataUrl) { toast('没有可预览的卡片'); return; }
    $('#journal-canvas').innerHTML =
      '<img src="' + generating.dataUrl + '" alt="复习卡片" class="preview-img">'
      + '<p class="save-tip">👆 长按图片保存到相册</p>';
    $('#screen-review').classList.remove('active');
    $('#screen-preview').classList.add('active');
    window.scrollTo(0, 0);
  }

  function handleSave() {
    if (!generating) { toast('请先生成卡片'); return; }
    // 先尝试 download（Android 有效），失败则提示长按
    const a = document.createElement('a');
    a.href = generating.dataUrl;
    a.download = 'saber_card_' + Date.now() + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // 同时显示提示（iOS 需要 long-press）
    const tip = $('#journal-canvas').querySelector('.save-tip');
    if (tip) tip.textContent = '如未弹出保存，请长按上方图片 → "保存到相册"';
    toast('已触发下载，若未弹出请长按图片保存');
  }

  function handleDelete() {
    if (!generating) { toast('没有可删除的卡片'); return; }
    generating = null;
    $('#journal-canvas').innerHTML = '';
    $('#screen-preview').classList.remove('active');
    $('#screen-review').classList.add('active');
    toast('已关闭卡片');
  }

  // ---------- 日期 ----------
  function todayInput() {
    const d = new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDate(s) {
    if (!s) return '';
    const p = n => (n < 10 ? '0' : '') + n;
    const [y, m, d] = s.split('-');
    return y + '·' + p(Number(m)) + '·' + p(Number(d));
  }

  // ---------- 启动 ----------
  document.addEventListener('DOMContentLoaded', init);
})();
