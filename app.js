/* =====================================================================
 * 출장경비 관리 — PWA
 *   · Apps Script를 JSON API로 호출한다 (fetch)
 *   · 오프라인이면 IndexedDB 대기열에 쌓고 온라인 복귀 시 자동 전송
 * ===================================================================== */

'use strict';

/* ---------------------------------------------------------------
 * 상태
 * --------------------------------------------------------------- */
var BOOT = { people:[], projects:[], categories:[], limitCats:{}, payments:[], payType:{},
             settings:{}, grades:['이사','차장','일반'], trips:[],
             sheetUrl:'#', driveUrl:'#', ocrAvailable:false };
var DASH = null;
var PW = '';
var NAME = '';
var ME = '';
var curTripId = '';
var editId = '';
var selectedCategory = '';
var selectedPayer = '';
var selectedProject = '';
var photoArchive = null;     // 저장용(작게)
var photoOcr = null;         // 인식용(크고 선명하게)
var busy = false;
var listFilter = '';
var tKind = '출장', tMembers = [], tDeduct = {}, tProjects = [], tEditId = '';

var $ = function(id){ return document.getElementById(id); };
var won = function(n){ return '₩' + (Number(n)||0).toLocaleString('ko-KR'); };
var digits = function(s){ return String(s).replace(/[^\d]/g,''); };
var comma = function(n){ return Number(n).toLocaleString('ko-KR'); };
var online = function(){ return navigator.onLine !== false; };

/** 서버가 1건짜리 목록을 배열이 아닌 객체로 보내도 안전하게 배열로 만든다. */
function arr(x){ return Array.isArray(x) ? x : (x == null ? [] : [x]); }

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function today(){
  var t = new Date();
  return t.getFullYear()+'-'+('0'+(t.getMonth()+1)).slice(-2)+'-'+('0'+t.getDate()).slice(-2);
}
function uuid(){
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
}
function toast(msg, kind){
  var t = $('toast');
  t.textContent = msg;
  t.className = 'on ' + (kind||'');
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.className=''; }, 3200);
}
function rateColor(r){
  if(r > 1) return 'var(--bad)';
  if(r >= 0.9) return 'var(--orange)';
  if(r >= 0.7) return 'var(--warn)';
  return 'var(--ok)';
}

/* ---------------------------------------------------------------
 * 통신
 *
 * Content-Type 을 text/plain 으로 보내 프리플라이트를 피한다.
 * (Apps Script는 응답 헤더를 직접 설정할 수 없어 단순 요청이어야 한다)
 * --------------------------------------------------------------- */
function api(action, payload){
  if(!window.API_URL || window.API_URL.indexOf('여기에') >= 0){
    return Promise.reject(new Error('config.js 에 Apps Script 주소를 넣어주세요.'));
  }
  return fetch(window.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ name: NAME, pw: PW, action: action, payload: payload || {} }),
  }).then(function(res){
    if(!res.ok) throw new Error('서버 응답 오류 (' + res.status + ')');
    return res.json();
  }).then(function(j){
    if(!j.ok){
      var e = new Error(j.error || '요청이 처리되지 않았습니다.');
      e.authFailed = !!j.authFailed;
      throw e;
    }
    ME = j.user || ME;
    return j.data;
  });
}

/* ---------------------------------------------------------------
 * 오프라인 대기열 (IndexedDB)
 * --------------------------------------------------------------- */
var DB = null;
function db(){
  if(DB) return Promise.resolve(DB);
  return new Promise(function(resolve, reject){
    var rq = indexedDB.open('expense-queue', 1);
    rq.onupgradeneeded = function(){
      var d = rq.result;
      if(!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath:'id' });
    };
    rq.onsuccess = function(){ DB = rq.result; resolve(DB); };
    rq.onerror = function(){ reject(rq.error); };
  });
}
function qPut(item){
  return db().then(function(d){
    return new Promise(function(res, rej){
      var tx = d.transaction('queue','readwrite');
      tx.objectStore('queue').put(item);
      tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
    });
  });
}
function qAll(){
  return db().then(function(d){
    return new Promise(function(res, rej){
      var rq = d.transaction('queue','readonly').objectStore('queue').getAll();
      rq.onsuccess = function(){ res(rq.result || []); };
      rq.onerror = function(){ rej(rq.error); };
    });
  }).catch(function(){ return []; });
}
function qDel(id){
  return db().then(function(d){
    return new Promise(function(res, rej){
      var tx = d.transaction('queue','readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
    });
  });
}

var flushing = false;
/** 대기열을 서버로 보낸다. 같은 id는 서버가 덮어쓰므로 중복 저장되지 않는다. */
function flushQueue(silent){
  if(flushing || !online() || !PW) return Promise.resolve();
  flushing = true;
  return qAll().then(function(items){
    if(!items.length) return null;
    var okCount = 0;
    var chain = Promise.resolve();
    items.forEach(function(it){
      chain = chain.then(function(){
        return api('saveExpense', it.payload)
          .then(function(){ okCount++; return qDel(it.id); })
          .catch(function(e){
            // 인증 실패나 네트워크 문제면 남겨두고 다음 기회에
            it.lastError = e.message;
            return qPut(it);
          });
      });
    });
    return chain.then(function(){
      if(okCount && !silent) toast(okCount + '건을 전송했습니다', 'ok');
      return okCount;
    });
  }).then(function(n){
    flushing = false;
    return refreshQueueBadge().then(function(){
      if(n) return refresh();
    });
  }).catch(function(){ flushing = false; });
}

function refreshQueueBadge(){
  return qAll().then(function(items){
    var btn = $('queueBtn');
    if(items.length){
      btn.hidden = false;
      btn.textContent = '대기 ' + items.length;
      btn.className = 'hlink hot';
    } else {
      btn.hidden = true;
    }
    return items;
  });
}

function showQueue(){
  qAll().then(function(items){
    var box = $('sheetModal');
    box.hidden = false;
    box.innerHTML = '<div class="modal-box">'
      + '<h2 style="margin:0 0 12px;font-size:15px">전송 대기 중인 내역</h2>'
      + (items.length ? items.map(function(it){
          var p = it.payload;
          return '<div class="kv"><span class="k">'+esc(p.date)+' · '+esc(p.category)
            + ' · '+esc(p.detail||'')+(it.lastError?'<br><span style="color:var(--bad);font-size:11px">'+esc(it.lastError)+'</span>':'')
            + '</span><span class="v">'+won(p.amount)+'</span></div>';
        }).join('') : '<div class="empty">대기 중인 내역이 없습니다</div>')
      + '<div class="row2" style="margin-top:14px">'
      + '<button class="btn ghost wide" id="qClose">닫기</button>'
      + '<button class="btn wide" id="qSend">지금 전송</button></div></div>';
    $('qClose').onclick = function(){ box.hidden = true; };
    $('qSend').onclick = function(){
      if(!online()){ toast('인터넷 연결이 없습니다', 'err'); return; }
      box.hidden = true;
      toast('전송 중…');
      flushQueue();
    };
  });
}

/* ---------------------------------------------------------------
 * 사진 — 저장용과 인식용을 따로 만든다
 * --------------------------------------------------------------- */

/** 캔버스를 그레이스케일 + 자동 대비로 다듬는다 (OCR 가독성 향상) */
function enhanceForOcr(ctx, w, h){
  var img = ctx.getImageData(0, 0, w, h);
  var d = img.data;
  var hist = new Uint32Array(256);

  for(var i = 0; i < d.length; i += 4){
    var g = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114) | 0;
    d[i] = d[i+1] = d[i+2] = g;
    hist[g]++;
  }
  // 하위 2% ~ 상위 98% 지점을 검정/흰색으로 늘린다
  var total = w * h, lo = 0, hi = 255, acc = 0;
  for(var v = 0; v < 256; v++){ acc += hist[v]; if(acc > total*0.02){ lo = v; break; } }
  acc = 0;
  for(var v2 = 255; v2 >= 0; v2--){ acc += hist[v2]; if(acc > total*0.02){ hi = v2; break; } }
  if(hi - lo < 32){ lo = 0; hi = 255; }            // 대비가 이미 낮으면 건드리지 않는다

  var scale = 255 / (hi - lo);
  var lut = new Uint8Array(256);
  for(var k = 0; k < 256; k++){
    var val = (k - lo) * scale;
    lut[k] = val < 0 ? 0 : (val > 255 ? 255 : val | 0);
  }
  for(var j = 0; j < d.length; j += 4){
    var nv = lut[d[j]];
    d[j] = d[j+1] = d[j+2] = nv;
  }
  ctx.putImageData(img, 0, 0);
}

function drawTo(img, maxDim, quality, enhance){
  var w = img.naturalWidth, h = img.naturalHeight;
  var s = Math.min(1, maxDim / Math.max(w, h));
  w = Math.max(1, Math.round(w*s)); h = Math.max(1, Math.round(h*s));
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  if(enhance) enhanceForOcr(ctx, w, h);
  var url = c.toDataURL('image/jpeg', quality);
  return { data: url.split(',')[1], mimeType:'image/jpeg', preview: url, w:w, h:h };
}

/** 저장용(1600px/72%)과 인식용(2400px/92% + 전처리) 두 장을 만든다. */
function prepareImages(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onerror = function(){ reject(new Error('파일을 읽지 못했습니다')); };
    reader.onload = function(e){
      var img = new Image();
      img.onerror = function(){ reject(new Error('이미지를 열지 못했습니다')); };
      img.onload = function(){
        try{
          resolve({
            archive: drawTo(img, 1600, 0.72, false),
            ocr:     drawTo(img, 2400, 0.92, true),
          });
        }catch(err){ reject(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function photoButtonsHtml(cameraLabel){
  return '<div class="photo-actions">'
    + '<div class="photo-btn" data-pick="camera">'
    +   '<span class="em">📷</span><span>' + esc(cameraLabel || '사진 촬영') + '</span></div>'
    + '<div class="photo-btn" data-pick="gallery">'
    +   '<span class="em">🖼️</span><span>갤러리에서 선택</span>'
    +   '<span class="sm2">캡처 화면도 가능</span></div>'
    + '</div>'
    + '<div class="paste-hint">PC에서는 캡처 이미지를 <b>Ctrl+V</b> 로 붙여넣을 수 있습니다</div>';
}
function bindPhotoButtons(){
  Array.prototype.forEach.call(
    document.querySelectorAll('#photoSlot [data-pick]'), function(el){
      el.onclick = function(){
        var id = el.dataset.pick === 'camera' ? 'cameraFile' : 'galleryFile';
        $(id).value = '';
        $(id).click();
      };
    });
}
function renderPhotoButtons(label){
  $('photoSlot').innerHTML = photoButtonsHtml(label);
  bindPhotoButtons();
}
function showPhoto(pair){
  if(!pair){
    photoArchive = null; photoOcr = null;
    renderPhotoButtons();
    $('cameraFile').value = ''; $('galleryFile').value = '';
    $('ocrResult').innerHTML = '';
    return;
  }
  photoArchive = pair.archive;
  photoOcr = pair.ocr;
  $('photoSlot').innerHTML =
    '<div class="photo-prev"><img src="'+pair.archive.preview+'" alt="영수증">'
    + '<button class="photo-x" id="photoX">삭제</button></div>';
  $('photoX').onclick = function(){ showPhoto(null); clearOcrMarks(); };
}

function handlePickedFile(f){
  if(!f) return;
  if(f.type && f.type.indexOf('image') !== 0){
    toast('이미지 파일만 등록할 수 있습니다', 'err');
    return;
  }
  clearOcrMarks();
  prepareImages(f).then(function(pair){
    showPhoto(pair);
    if(!online()){
      $('ocrResult').innerHTML =
        '<div class="ocr-box bad">오프라인이라 자동 인식을 할 수 없습니다.<br>'
        + '<span style="color:var(--faint)">아래에 직접 입력하시면 저장됩니다.</span></div>';
      return;
    }
    if(BOOT.ocrAvailable) runOcr();
  }).catch(function(err){ toast(err.message, 'err'); });
}

/* ---------------------------------------------------------------
 * 인식
 * --------------------------------------------------------------- */
function markField(id, cls){
  var el = $(id);
  el.classList.remove('ocr-filled','ocr-unsure');
  if(cls) el.classList.add(cls);
}
function clearOcrMarks(){
  ['amount','date','detail'].forEach(function(id){ markField(id, ''); });
  $('amountCands').innerHTML = '';
  $('ocrResult').innerHTML = '';
}

/** 사람이 이미 값을 넣은 칸은 덮어쓰지 않는다. */
function isBlank(id){ return !String($(id).value || '').trim(); }

function runOcr(){
  if(!photoOcr){ toast('먼저 사진을 등록하세요', 'err'); return; }
  $('ocrResult').innerHTML =
    '<div class="ocr-box"><span class="spin"></span> 영수증을 읽는 중… (5~15초)</div>';

  api('recognize', {
    photo: { data: photoOcr.data, mimeType: photoOcr.mimeType },
    tripId: curTripId,
  }).then(function(r){
    var applied = [];

    if(r.amount > 0 && isBlank('amount')){
      $('amount').value = comma(r.amount);
      markField('amount', r.amountConfident ? 'ocr-filled' : 'ocr-unsure');
      applied.push(['금액', won(r.amount) + (r.amountConfident ? '' : '  (확인 필요)')]);
      recalcPerHead();
    }
    renderAmountCands(r.amountCandidates || []);

    if(r.date){
      if(isBlank('date') || $('date').value === today()){
        $('date').value = r.date;
        markField('date', r.dateConfident ? 'ocr-filled' : 'ocr-unsure');
      }
      applied.push(['날짜', r.date + (r.dateConfident ? '' : '  (출장 기간 밖)')]);
    }
    if(r.store && isBlank('detail')){
      $('detail').value = r.store;
      markField('detail', 'ocr-filled');
      applied.push(['상호', r.store]);
    }
    if(r.category && !selectedCategory){
      selectedCategory = r.category;
      renderCatChips();
      applied.push(['항목', r.category + (r.categoryReason ? '  (' + r.categoryReason + ')' : '')]);
    }
    if(r.cardLast4){
      applied.push(['카드', '****' + r.cardLast4]);
      var hit = BOOT.payments.filter(function(p){ return p.indexOf(r.cardLast4) >= 0; });
      if(hit.length === 1){ $('payment').value = hit[0]; syncPayerBox(); saveCtx(); }
    }

    if(!applied.length){
      $('ocrResult').innerHTML =
        '<div class="ocr-box bad">읽어낸 값이 없습니다. <b>직접 입력</b>해 주세요.<br>'
        + '<span style="color:var(--faint)">밝은 곳에서 영수증이 화면에 꽉 차게, 수직으로 찍으면 잘 인식됩니다.</span>'
        + '<div style="margin-top:9px"><button class="mini" id="ocrRetry">다시 인식</button></div></div>';
    } else {
      var unsure = (r.amount > 0 && !r.amountConfident) || (r.date && !r.dateConfident);
      $('ocrResult').innerHTML =
        '<div class="ocr-box ' + (unsure ? 'bad' : 'good') + '">'
        + '<div style="color:var(--' + (unsure ? 'warn' : 'ok') + ');margin-bottom:5px">'
        +   (unsure ? '△ 확인이 필요합니다 — 값을 확인하고 고치세요' : '✓ 인식 완료 — 값이 맞는지 확인하세요') + '</div>'
        + applied.map(function(a){
            return '<div class="ocr-line"><span>'+esc(a[0])+'</span><b>'+esc(a[1])+'</b></div>';
          }).join('')
        + '<div style="margin-top:9px"><button class="mini" id="ocrRetry">다시 인식</button></div></div>';
    }
    var rb = $('ocrRetry');
    if(rb) rb.onclick = runOcr;
  }).catch(function(e){
    $('ocrResult').innerHTML =
      '<div class="ocr-box bad">인식 실패: '+esc(e.message)+'<br>'
      + '<span style="color:var(--faint)">아래에 직접 입력하시면 됩니다.</span>'
      + '<div style="margin-top:9px"><button class="mini" id="ocrRetry">다시 시도</button></div></div>';
    var rb2 = $('ocrRetry');
    if(rb2) rb2.onclick = runOcr;
  });
}

/** 금액 후보를 칩으로 보여준다. 탭 한 번으로 교체된다. */
function renderAmountCands(list){
  var box = $('amountCands');
  var cur = Number(digits($('amount').value)) || 0;
  var alt = list.filter(function(v){ return v !== cur; }).slice(0, 2);
  if(!alt.length){ box.innerHTML = ''; return; }
  box.innerHTML = '<span style="font-size:11px;color:var(--faint);align-self:center">다른 후보</span>'
    + alt.map(function(v){ return '<div class="chip sm alt" data-v="'+v+'">'+won(v)+'</div>'; }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('[data-v]'), function(el){
    el.onclick = function(){
      $('amount').value = comma(Number(el.dataset.v));
      markField('amount', 'ocr-filled');
      recalcPerHead();
      renderAmountCands(list);
    };
  });
}

/* ---------------------------------------------------------------
 * 입력 화면
 * --------------------------------------------------------------- */
var LS = 'expense-pwa-v1';
function saveCtx(){
  try{
    localStorage.setItem(LS, JSON.stringify({
      tripId: curTripId, project: selectedProject, payment: $('payment').value
    }));
  }catch(e){}
}
function loadCtx(){
  try{ return JSON.parse(localStorage.getItem(LS) || '{}'); }catch(e){ return {}; }
}

function renderCatChips(){
  var el = $('catChips');
  el.innerHTML = '';
  BOOT.categories.forEach(function(c){
    var d = document.createElement('div');
    d.className = 'chip' + (c === selectedCategory ? ' on' : '');
    d.innerHTML = esc(c) + (BOOT.limitCats[c] ? '<span class="g">한도</span>' : '');
    d.onclick = function(){ selectedCategory = c; renderCatChips(); };
    el.appendChild(d);
  });
}

function renderProjectChips(){
  var el = $('projectChips');
  el.innerHTML = '';
  var trip = BOOT.trips.filter(function(t){ return t.id === curTripId; })[0];
  var names = trip ? arr(trip.projects).slice() : [];
  if(selectedProject && names.indexOf(selectedProject) < 0) names.push(selectedProject);
  if(!names.length){
    el.innerHTML = '<div class="dimlbl" style="font-size:13px">출장 탭에서 프로젝트/발주처를 먼저 등록하세요</div>';
    return;
  }
  names.forEach(function(n){
    var d = document.createElement('div');
    d.className = 'chip sm' + (n === selectedProject ? ' on' : '');
    d.textContent = n;
    d.onclick = function(){ selectedProject = (selectedProject === n) ? '' : n; renderProjectChips(); saveCtx(); };
    el.appendChild(d);
  });
}
function renderPayerChips(){
  var el = $('payerChips');
  el.innerHTML = '';
  var names = BOOT.people.map(function(p){ return p.name; });
  if(selectedPayer && names.indexOf(selectedPayer) < 0) names.push(selectedPayer);
  if(!names.length){
    el.innerHTML = '<div class="dimlbl" style="font-size:13px">기준정보 시트에 인원을 등록하세요</div>';
    return;
  }
  names.forEach(function(n){
    var d = document.createElement('div');
    d.className = 'chip sm' + (n === selectedPayer ? ' on' : '');
    d.textContent = n;
    d.onclick = function(){ selectedPayer = (selectedPayer === n) ? '' : n; renderPayerChips(); };
    el.appendChild(d);
  });
}
function syncPayerBox(){
  var personal = BOOT.payType[$('payment').value] === '개인';
  $('payerBox').hidden = !personal;
  if(personal){
    if(!selectedPayer && ME) selectedPayer = ME;    // 보통 본인이 썼다
    renderPayerChips();
  }
}
function recalcPerHead(){
  var amt = Number(digits($('amount').value)) || 0;
  var n = Number($('people').value) || 0;
  $('perHead').value = (n > 0 && amt > 0) ? won(Math.round(amt/n)) : '-';
}
function renderNoTripWarn(){
  $('noTripWarn').innerHTML = curTripId ? ''
    : '<div class="warn-box">먼저 <b>출장</b> 탭에서 출장을 만들거나 선택하세요.</div>';
}
function renderEditBanner(){
  $('editBanner').innerHTML = editId
    ? '<div class="editbar"><span>✎ 기존 내역을 <b>수정 중</b>입니다</span>'
      + '<button class="mini" id="cancelEdit">새로 입력</button></div>'
    : '';
  $('deleteBtn').hidden = !editId;
  $('saveBtn').textContent = editId ? '수정 저장' : '저장';
  if(editId) $('cancelEdit').onclick = function(){ clearEntry(true); };
}

function collect(){
  return {
    id: editId || uuid(),
    upsert: true,
    tripId: curTripId,
    date: $('date').value,
    project: selectedProject,
    category: selectedCategory,
    detail: $('detail').value.trim(),
    amount: Number(digits($('amount').value)) || 0,
    people: Number($('people').value) || 0,
    members: '',
    payment: $('payment').value,
    payer: selectedPayer,
    note: $('note').value.trim(),
    receipt: window._editReceipt || '',
    photo: photoArchive ? { data: photoArchive.data, mimeType: photoArchive.mimeType } : null
  };
}

function saveExpense(){
  if(busy) return;
  var p = collect();
  if(!p.tripId){ toast('출장을 먼저 선택하세요', 'err'); return; }
  if(!p.date){ toast('사용일자를 입력하세요', 'err'); return; }
  if(!p.category){ toast('항목을 선택하세요', 'err'); return; }
  if(!p.amount){ toast('금액을 입력하세요', 'err'); return; }
  if(BOOT.payType[p.payment] === '개인' && !p.payer){
    toast('개인 결제는 "쓴 사람"을 선택하세요', 'err'); return;
  }

  // 오프라인이면 대기열에 넣고 끝낸다
  if(!online()){
    qPut({ id: p.id, at: Date.now(), payload: p }).then(function(){
      toast('오프라인 — 대기열에 저장했습니다', 'ok');
      clearEntry(true);
      refreshQueueBadge();
    }).catch(function(e){ toast('대기열 저장 실패: ' + e.message, 'err'); });
    return;
  }

  busy = true;
  var btn = $('saveBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 저장 중…';

  api('saveExpense', p).then(function(res){
    toast((editId ? '수정 완료 · ' : '저장 완료 · ') + won(p.amount), 'ok');
    clearEntry(true);
    if(res && res.dashboard) applyDashboard(res.dashboard);
  }).catch(function(e){
    // 전송이 안 되면 잃지 않도록 대기열로
    return qPut({ id: p.id, at: Date.now(), payload: p, lastError: e.message }).then(function(){
      toast('전송 실패 — 대기열에 보관했습니다', 'err');
      clearEntry(true);
      refreshQueueBadge();
    });
  }).then(function(){
    busy = false;
    btn.disabled = false;
    renderEditBanner();
  });
}

function deleteExpense(){
  if(!editId || busy) return;
  if(!confirm('이 내역을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.\n(영수증 사진은 드라이브에 남습니다)')) return;
  if(!online()){ toast('삭제는 인터넷 연결이 필요합니다', 'err'); return; }

  busy = true;
  var btn = $('deleteBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  api('deleteExpense', { id: editId }).then(function(res){
    toast('삭제했습니다', 'ok');
    clearEntry(true);
    if(res && res.dashboard) applyDashboard(res.dashboard);
    gotoTab('list');
  }).catch(function(e){
    toast('삭제 실패: ' + e.message, 'err');
  }).then(function(){
    busy = false;
    btn.disabled = false;
    btn.textContent = '삭제';
    renderEditBanner();
  });
}

function clearEntry(resetEdit){
  $('amount').value = '';
  $('detail').value = '';
  $('note').value = '';
  $('people').value = 0;
  $('perHead').value = '-';
  showPhoto(null);
  clearOcrMarks();
  window._editReceipt = '';
  if(resetEdit){ editId = ''; selectedPayer = ''; }
  renderEditBanner();
  syncPayerBox();
}

function startEdit(x){
  editId = x.id;
  curTripId = x.tripId || curTripId;
  $('date').value = x.date || today();
  selectedProject = x.project || '';
  selectedCategory = x.category || '';
  $('detail').value = x.detail || '';
  $('amount').value = x.amount ? comma(x.amount) : '';
  $('people').value = x.people || 0;
  $('payment').value = x.payment || '';
  selectedPayer = x.payer || '';
  $('note').value = x.note || '';
  window._editReceipt = x.receipt || '';
  photoArchive = null; photoOcr = null;

  renderPhotoButtons(x.receipt ? '사진 다시 촬영' : '사진 촬영');
  $('ocrResult').innerHTML = x.receipt
    ? '<div class="ocr-box"><a href="'+esc(x.receipt)+'" target="_blank" rel="noopener" style="color:var(--accent)">기존 영수증 보기</a></div>'
    : '';
  $('amountCands').innerHTML = '';

  renderCatChips();
  renderProjectChips();
  syncPayerBox();
  recalcPerHead();
  renderEditBanner();
  gotoTab('input');
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------
 * 내역
 * --------------------------------------------------------------- */
function renderFilterChips(){
  var el = $('filterChips');
  el.innerHTML = '';
  ['전체'].concat(BOOT.categories).forEach(function(c){
    var key = (c === '전체') ? '' : c;
    var d = document.createElement('div');
    d.className = 'chip sm' + (listFilter === key ? ' on' : '');
    d.textContent = c;
    d.onclick = function(){ listFilter = key; renderFilterChips(); renderList(); };
    el.appendChild(d);
  });
}

function renderList(){
  var box = $('listBody');
  var q = $('search').value.trim().toLowerCase();

  qAll().then(function(pending){
    var rows = (DASH ? DASH.recent : []).slice();
    // 아직 전송 안 된 건도 함께 보여준다
    var pendRows = pending
      .filter(function(it){ return !curTripId || it.payload.tripId === curTripId; })
      .map(function(it){
        var p = it.payload;
        return { id:p.id, tripId:p.tripId, date:p.date, project:p.project, category:p.category,
                 detail:p.detail, amount:p.amount, people:p.people, payment:p.payment,
                 payer:p.payer, refund:false, receipt:'', note:p.note, _pending:true };
      });
    rows = pendRows.concat(rows);

    rows = rows.filter(function(r){
      if(listFilter && r.category !== listFilter) return false;
      if(!q) return true;
      return [r.detail, r.category, r.project, r.payment, r.payer, r.date]
        .join(' ').toLowerCase().indexOf(q) >= 0;
    });

    if(!rows.length){ box.innerHTML = '<div class="empty">해당하는 내역이 없습니다</div>'; return; }

    box.innerHTML = rows.map(function(r, i){
      return '<div class="item'+(r._pending?' pending':'')+'" data-i="'+i+'">'
        + '<div class="ic">'+esc(r._pending ? '대기' : String(r.category||'').slice(0,4))+'</div>'
        + '<div class="body">'
        +   '<div class="t1">'+esc(r.detail || r.category || '(내용 없음)')+'</div>'
        +   '<div class="t2">'+esc(r.date)+' · '+esc(r.project||'발주처미지정')+' · '+esc(r.payment)
        +     (r.people ? ' · '+r.people+'명' : '')
        +     (r.receipt ? ' · 영수증' : '')
        +     (r._pending ? ' · 전송 대기' : '')+'</div>'
        + '</div>'
        + '<div class="right"><div class="amt">'+won(r.amount)+'</div>'
        +   (r.refund ? '<div class="tagr">환급 '+esc(r.payer||'')+'</div>' : '')+'</div>'
        + '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.item'), function(el){
      el.onclick = function(){
        var r = rows[Number(el.dataset.i)];
        if(r._pending){ toast('전송된 뒤에 수정할 수 있습니다'); return; }
        startEdit(r);
      };
    });
  });
}

/* ---------------------------------------------------------------
 * 현황
 * --------------------------------------------------------------- */
function bars(list, showCap){
  var colors = ['#7c5cff','#33e0b0','#ff5c8a','#ffb84d','#5cc8ff','#c07cff','#ff8a5c','#8affc1'];
  var max = list.reduce(function(m,t){ return Math.max(m, t.amount, t.refCap||0); }, 1);
  return list.map(function(t, i){
    var hasCap = showCap && t.refCap > 0;
    var r = hasCap ? t.amount / t.refCap : 0;
    var col = hasCap ? rateColor(r) : colors[i % colors.length];
    var pct = hasCap ? Math.min(100, r*100) : Math.round(t.amount / max * 100);
    return '<div class="bar-row">'
      + '<div class="bar-head"><span class="n">'+esc(t.category || t.name)+'</span>'
      +   '<span class="v">'+won(t.amount)
      +     (hasCap ? ' <small>/ 산출 '+won(t.refCap)+'</small>' : '')+'</span></div>'
      + '<div class="bar"><span style="width:'+pct+'%;background:'+col+'"></span></div>'
      + (hasCap ? '<div class="bar-sub"><span>'+(r*100).toFixed(0)+'%</span>'
          + '<span>'+(t.amount > t.refCap ? '산출액 초과' : '')+'</span></div>' : '')
      + '</div>';
  }).join('');
}
function kvList(list, emptyMsg){
  if(!list.length) return '<div class="empty">'+emptyMsg+'</div>';
  return list.map(function(x){
    return '<div class="kv"><span class="k">'+esc(x.name)+'</span>'
      + '<span class="v">'+won(x.amount)+'</span></div>';
  }).join('');
}

function applyDashboard(d){
  d.categories = arr(d.categories);
  d.payments   = arr(d.payments);
  d.refunds    = arr(d.refunds);
  d.projects   = arr(d.projects);
  d.recent     = arr(d.recent);
  DASH = d;
  if(d.sheetUrl) $('sheetLink').href = d.sheetUrl;
  if(d.driveUrl) $('driveLink').href = d.driveUrl;
  renderNoTripWarn();

  var name = d.trip ? d.trip.name : '';
  $('hTrip').textContent = name || '출장경비 관리';
  $('statTripName').textContent = name ? '· ' + name : '· 전체';
  $('statTotal').textContent = won(d.total);
  $('statCount').textContent = d.count + '건';

  if(d.hasLimit){
    var col = rateColor(d.limitRate);
    $('gauge').innerHTML =
      '<div class="gauge">'
      + '<div class="gauge-top"><span class="gauge-lbl">한도 '+won(d.limitTotal)+' 대비 '
      +   '<span style="color:var(--faint)">(숙박+식비+일비)</span></span>'
      +   '<span class="gauge-pct" style="color:'+col+'">'+(d.limitRate*100).toFixed(1)+'%</span></div>'
      + '<div class="gauge-bar"><span style="width:'+Math.min(100,d.limitRate*100)+'%;background:'+col+'"></span></div>'
      + '<div class="gauge-foot">'
      +   '<span style="color:var(--faint)">사용 <b style="color:var(--text)">'+won(d.limitUsed)+'</b></span>'
      +   (d.limitRemain >= 0
            ? '<span style="color:var(--faint)">잔여 <b style="color:'+col+'">'+won(d.limitRemain)+'</b></span>'
            : '<span style="color:var(--bad)">초과 <b>'+won(-d.limitRemain)+'</b></span>')
      + '</div>'
      + '<div class="hint">기타 비용 '+won(d.otherUsed)+' 은(는) 한도에 포함되지 않습니다.</div>'
      + '</div>';
  } else if(d.trip && d.trip.kind !== '출장'){
    $('gauge').innerHTML = '<div class="nobudget"><b>'+esc(d.trip.kind)+'</b> · 한도 없이 기록만 합니다</div>';
  } else if(d.trip){
    $('gauge').innerHTML = '<div class="nobudget">한도가 0입니다<br>'
      + '<span style="color:var(--accent)">출장 탭</span>에서 일수·박수·참석자를 입력하세요</div>';
  } else {
    $('gauge').innerHTML = '<div class="nobudget">출장을 선택하면 한도가 표시됩니다</div>';
  }

  var lim = d.categories.filter(function(c){ return c.limitTarget; });
  var oth = d.categories.filter(function(c){ return !c.limitTarget; });
  $('limitBars').innerHTML = lim.length
    ? bars(lim, true)
      + '<div class="hint">막대는 항목별 산출액 대비입니다. <b>실제 한도는 세 항목의 총액 기준</b>이라 '
      + '한 항목이 넘어도 총액만 안 넘으면 됩니다.</div>'
    : '<div class="empty">-</div>';
  $('otherBars').innerHTML = oth.length ? bars(oth, false)
    : '<div class="empty">기타 비용이 없습니다</div>';
  $('refundList').innerHTML = kvList(d.refunds, '개인 선지출 내역이 없습니다');
  $('paymentList').innerHTML = kvList(d.payments, '-');
  $('projectList2').innerHTML = kvList(d.projects, '-');

  renderList();
}

function refresh(){
  if(!online()){ renderList(); return Promise.resolve(); }
  return api('dashboard', { tripId: curTripId })
    .then(applyDashboard)
    .catch(function(e){ toast('불러오기 실패: ' + e.message, 'err'); });
}

/* ---------------------------------------------------------------
 * 출장
 * --------------------------------------------------------------- */
/** 사무실이면 시작일/종료일 대신 "해당 월" 칸을 보여준다. */
function syncTripDateMode(){
  var isOffice = tKind === '사무실';
  $('tDateRange').hidden = isOffice;
  $('tMonthField').hidden = !isOffice;
}
function renderKindChips(){
  var el = $('kindChips');
  el.innerHTML = '';
  ['출장','외근','사무실'].forEach(function(k){
    var d = document.createElement('div');
    d.className = 'chip' + (tKind === k ? ' on' : '');
    d.textContent = k + (k==='출장' ? ' (숙박)' : ' (한도 없음)');
    d.onclick = function(){
      tKind = k;
      if(tKind !== '출장') $('tNights').value = 0;
      syncTripDateMode();
      renderKindChips(); renderMemberChips(); renderLimitCalc(); syncDocButtons(); renderTripNamePreview();
    };
    el.appendChild(d);
  });
}
function renderTripProjectChips(){
  var el = $('tProjectChips');
  el.innerHTML = '';
  BOOT.projects.forEach(function(name){
    var on = tProjects.indexOf(name) >= 0;
    var d = document.createElement('div');
    d.className = 'chip sm' + (on ? ' on' : '');
    d.textContent = name;
    d.onclick = function(){
      var i = tProjects.indexOf(name);
      if(i >= 0) tProjects.splice(i,1); else tProjects.push(name);
      renderTripProjectChips(); renderTripNamePreview();
    };
    el.appendChild(d);
  });
  var add = document.createElement('div');
  add.className = 'chip sm alt';
  var inp = document.createElement('input');
  inp.className = 'chip-inline-input';
  inp.placeholder = '+ 새 발주처';
  inp.onclick = function(e){ e.stopPropagation(); };
  inp.onkeydown = function(e){
    if(e.key !== 'Enter') return;
    e.preventDefault();
    var v = inp.value.trim();
    if(!v) return;
    if(BOOT.projects.indexOf(v) < 0) BOOT.projects.push(v);
    if(tProjects.indexOf(v) < 0) tProjects.push(v);
    inp.value = '';
    renderTripProjectChips();
    renderProjectChips();
    renderTripNamePreview();
  };
  add.appendChild(inp);
  el.appendChild(add);
}
/** 시작일·종료일(yyyy-mm-dd 문자열) → "yyyy-mm-dd~dd"(같은 달) 또는 "yyyy-mm-dd ~ yyyy-mm-dd" */
function fmtTripRangeLocal(s, e){
  if(!s) return '';
  if(!e || e === s) return s;
  var sameMonth = s.slice(0,7) === e.slice(0,7);
  return sameMonth ? s + '~' + e.slice(8,10) : s + ' ~ ' + e;
}
/** 백엔드 saveTrip의 이름 생성 로직과 동일하게 미리보기용 출장명을 계산한다. */
function calcTripNamePreview(){
  var s = $('tStart').value, e = $('tEnd').value;
  if(!s) return '';
  // 사무실은 월 단위 이름(yyyy-MM), 출장·외근은 날짜(구간) 뒤에 프로젝트/발주처를 항상 붙인다.
  var range = tKind === '사무실' ? s.slice(0, 7) : fmtTripRangeLocal(s, e);
  var base = (tKind !== '사무실' && tProjects.length) ? range + ' (' + tProjects[0] + ')' : range;
  var remaining = (tKind !== '사무실' && tProjects.length) ? tProjects.slice(1) : tProjects;
  var others = BOOT.trips.filter(function(t){ return t.id !== tEditId; }).map(function(t){ return t.name; });
  if(others.indexOf(base) < 0) return base;
  for(var i = 0; i < remaining.length; i++){
    var cand = base + ' (' + remaining[i] + ')';
    if(others.indexOf(cand) < 0) return cand;
  }
  var n = 2;
  while(others.indexOf(base + '-' + n) >= 0) n++;
  return base + '-' + n;
}
function renderTripNamePreview(){
  $('tNamePreview').value = calcTripNamePreview();
}
function renderMemberChips(){
  var el = $('tMembers');
  el.innerHTML = '';
  var all = BOOT.people.slice();
  tMembers.forEach(function(n){
    if(!all.some(function(p){ return p.name === n; })) all.push({ name:n, grade:'일반' });
  });
  if(!all.length){
    el.innerHTML = '<div class="dimlbl" style="font-size:13px">기준정보 시트에 인원을 등록하세요</div>';
    return;
  }
  all.forEach(function(p){
    var on = tMembers.indexOf(p.name) >= 0;
    var d = document.createElement('div');
    d.className = 'chip sm' + (on ? ' on' : '');
    d.innerHTML = esc(p.name) + '<span class="g">' + esc(p.grade) + '</span>';
    d.onclick = function(e){
      if(e.target.closest('.chip-deduct')) return;
      var i = tMembers.indexOf(p.name);
      if(i >= 0){ tMembers.splice(i,1); delete tDeduct[p.name]; }
      else tMembers.push(p.name);
      renderMemberChips(); renderLimitCalc();
    };
    if(on && tKind === '출장'){
      var wrap = document.createElement('label');
      wrap.className = 'chip-deduct';
      wrap.title = '며칠 일찍 복귀';
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.inputMode = 'numeric';
      inp.value = tDeduct[p.name] || '';
      inp.placeholder = '0';
      inp.onclick = function(e){ e.stopPropagation(); };
      inp.onchange = function(){
        var v = Math.max(0, Number(inp.value) || 0);
        if(v) tDeduct[p.name] = v; else delete tDeduct[p.name];
        renderLimitCalc();
      };
      wrap.appendChild(inp);
      wrap.appendChild(document.createTextNode('일 조기복귀'));
      d.appendChild(wrap);
    }
    el.appendChild(d);
  });
}
function gradeOf(name){
  var hit = BOOT.people.filter(function(p){ return p.name === name; });
  return hit.length ? hit[0].grade : '일반';
}
function calcLimitsLocal(){
  var s = BOOT.settings;
  var days = Math.max(0, Number($('tDays').value) || 0);
  var nights = Math.max(0, Number($('tNights').value) || 0);
  if(tKind !== '출장') return { lodging:0, meal:0, daily:0, total:0, perNight:0, days:days, nights:0, hasDeduct:false, deductRows:[] };
  var rate = { '이사': s['숙박_이사'], '차장': s['숙박_차장'], '일반': s['숙박_일반'] };
  var mealRate = Number(s['식비_1일']) || 0;
  var dailyRate = Number(s['일비_1일']) || 0;
  var lodging = 0, meal = 0, daily = 0, perNight = 0, hasDeduct = false;
  var deductRows = [];
  tMembers.forEach(function(n){
    var grade = gradeOf(n);
    var r = Number(rate[grade]) || 0;
    var cut = Math.max(0, Number(tDeduct[n]) || 0);
    var effDays = Math.max(0, days - cut);
    var effNights = Math.max(0, nights - cut);
    perNight += r;
    lodging += r * effNights;
    meal += mealRate * effDays;
    daily += dailyRate * effDays;
    if(cut){
      hasDeduct = true;
      var fullAmt = r * nights + (mealRate + dailyRate) * days;
      var actAmt = r * effNights + (mealRate + dailyRate) * effDays;
      deductRows.push({ name:n, grade:grade, cut:cut, effDays:effDays, effNights:effNights,
                         delta: fullAmt - actAmt });
    }
  });
  return { lodging:lodging, meal:meal, daily:daily, total:lodging+meal+daily,
           perNight:perNight, days:days, nights:nights, hasDeduct:hasDeduct, deductRows:deductRows };
}
function renderLimitCalc(){
  var c = calcLimitsLocal();
  if(tKind !== '출장'){
    $('limitCalc').innerHTML =
      '<div class="calc-row"><span><b>'+esc(tKind)+'</b>은(는) 한도를 비교하지 않고 <b>기록만</b> 합니다.</span></div>'
      + (tKind === '외근'
          ? '<div class="calc-row f">참고 규정 · 식비 1끼 '+won(BOOT.settings['외근_식비_1끼'])
            + ' / 일비 '+won(BOOT.settings['외근_일비'])+'</div>'
          : '');
    return;
  }
  var n = tMembers.length;
  $('limitCalc').innerHTML =
      '<div class="calc-row"><span>숙박 <span class="f">'+won(c.perNight)+' × '+c.nights+'박'+(c.hasDeduct?' (차감 적용)':'')+'</span></span>'
    +   '<span>'+won(c.lodging)+'</span></div>'
    + '<div class="calc-row"><span>식비 <span class="f">'+won(BOOT.settings['식비_1일'])+' × '+n+'명 × '+c.days+'일'+(c.hasDeduct?' (차감 적용)':'')+'</span></span>'
    +   '<span>'+won(c.meal)+'</span></div>'
    + '<div class="calc-row"><span>일비 <span class="f">'+won(BOOT.settings['일비_1일'])+' × '+n+'명 × '+c.days+'일'+(c.hasDeduct?' (차감 적용)':'')+'</span></span>'
    +   '<span>'+won(c.daily)+'</span></div>'
    + '<div class="calc-total"><span>총한도</span><span>'+won(c.total)+'</span></div>'
    + (n ? '' : '<div class="calc-row f" style="color:var(--warn)">참석자를 선택하세요</div>')
    + (c.hasDeduct
        ? '<div class="calc-deduct">' + c.deductRows.map(function(row){
            return '<div class="calc-row f"><span>'+esc(row.name)+' ('+esc(row.grade)+') · '+row.cut+'일 조기복귀'
              + ' → 숙박 '+row.effNights+'박·식비/일비 '+row.effDays+'일</span>'
              + '<span>-'+won(row.delta)+'</span></div>';
          }).join('') + '</div>'
        : '');
}
function renderTripSelect(){
  $('tripSelect').innerHTML = '<option value="">+ 새 출장 만들기</option>'
    + BOOT.trips.map(function(t){
        return '<option value="'+esc(t.id)+'"'+(t.id===tEditId?' selected':'')+'>'
          + esc(t.name) + ' (' + esc(t.kind) + ')</option>';
      }).join('');
}
function loadTripForm(id){
  tEditId = id || '';
  var t = BOOT.trips.filter(function(x){ return x.id === tEditId; })[0];
  if(!t){
    tKind = '출장'; tMembers = []; tDeduct = {}; tProjects = [];
    ['tStart','tEnd','tMemo','tMonth'].forEach(function(k){ $(k).value = ''; });
    $('tDays').value = 0; $('tNights').value = 0;
  } else {
    tKind = t.kind; tMembers = arr(t.members).slice();
    tDeduct = Object.assign({}, t.deduct || {});
    tProjects = arr(t.projects).slice();
    $('tStart').value = t.start; $('tEnd').value = t.end;
    $('tMonth').value = t.kind === '사무실' ? String(t.start || '').slice(0, 7) : '';
    $('tDays').value = t.days; $('tNights').value = t.nights; $('tMemo').value = t.memo;
  }
  syncTripDateMode();
  renderKindChips(); renderMemberChips(); renderTripProjectChips(); renderTripNamePreview(); renderLimitCalc(); renderTripSelect(); syncDocButtons();
  $('docResult').innerHTML = '';
}
function autoDays(){
  var s = $('tStart').value, e = $('tEnd').value;
  renderTripNamePreview();
  if(!s || !e) return;
  var diff = Math.round((new Date(e) - new Date(s)) / 86400000);
  if(isNaN(diff) || diff < 0) return;
  $('tDays').value = diff + 1;
  $('tNights').value = tKind !== '출장' ? 0 : diff;
  renderLimitCalc();
}
function saveTrip(){
  if(busy) return;
  if(!$('tStart').value){ toast('시작일을 입력하세요', 'err'); return; }
  if(!online()){ toast('출장 저장은 인터넷 연결이 필요합니다', 'err'); return; }

  busy = true;
  var btn = $('tripSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 저장 중…';

  api('saveTrip', {
    id: tEditId, kind: tKind, projects: tProjects,
    start: $('tStart').value, end: $('tEnd').value,
    days: Number($('tDays').value)||0, nights: Number($('tNights').value)||0,
    members: tMembers, deduct: tDeduct, memo: $('tMemo').value.trim()
  }).then(function(res){
    toast('출장 저장 완료', 'ok');
    return api('bootstrap').then(function(b){
      b.people = arr(b.people); b.projects = arr(b.projects);
      b.categories = arr(b.categories); b.payments = arr(b.payments);
      b.trips = arr(b.trips);
      BOOT = b;
      tEditId = res.trip.id;
      curTripId = res.trip.id;
      saveCtx();
      renderProjectChips();
      renderTripProjectChips();
      $('tNamePreview').value = res.trip.name;
      renderTripSelect(); renderCatChips(); renderFilterChips(); syncDocButtons();
      return refresh();
    });
  }).catch(function(e){
    toast('저장 실패: ' + e.message, 'err');
  }).then(function(){
    busy = false;
    btn.disabled = false;
    btn.textContent = '출장 저장';
  });
}

/* ---- 제출 서류 ---- */
function syncDocButtons(){
  $('planBtn').hidden = (tKind !== '출장');
  $('planBtn').disabled = !tEditId;
  $('reportBtn').disabled = !tEditId;
}
function makeDoc(kind){
  if(!tEditId){ toast('출장을 먼저 저장하세요', 'err'); return; }
  if(!online()){ toast('서류 생성은 인터넷 연결이 필요합니다', 'err'); return; }

  var btn = kind === 'tripPlan' ? $('planBtn') : $('reportBtn');
  var label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  $('docResult').innerHTML = '';

  api(kind, { tripId: tEditId }).then(function(r){
    $('docResult').innerHTML = '<div class="ok-box">✓ '+esc(r.name)+' 생성 완료<br>'
      + '<a href="'+esc(r.url)+'" target="_blank" rel="noopener">파일 열기 / 내려받기</a></div>';
    toast('서류를 만들었습니다', 'ok');
  }).catch(function(e){
    $('docResult').innerHTML = '<div class="warn-box">'+esc(e.message)+'</div>';
  }).then(function(){
    btn.disabled = false;
    btn.textContent = label;
    syncDocButtons();
  });
}

/* ---------------------------------------------------------------
 * 탭 / 네트워크 표시
 * --------------------------------------------------------------- */
function gotoTab(page){
  document.querySelectorAll('.tab').forEach(function(x){
    x.classList.toggle('on', x.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(function(x){
    x.classList.toggle('on', x.id === 'page-' + page);
  });
  $('savebar').hidden = (page !== 'input');
  if(page !== 'input') window.scrollTo(0, 0);
  if(page === 'status' || page === 'list') refresh();
  if(page === 'trip'){ if(!tEditId) loadTripForm(curTripId); renderLimitCalc(); }
}

function syncNetbar(){
  var bar = $('netbar');
  if(online()){ bar.hidden = true; }
  else {
    bar.hidden = false;
    bar.textContent = '오프라인 — 입력은 저장되고 연결되면 자동 전송됩니다';
  }
}

/* ---------------------------------------------------------------
 * 로그인 / 시작
 * --------------------------------------------------------------- */
var PW_KEY = 'expense-pwa-pw';
var NAME_KEY = 'expense-pwa-name';

function doLogin(name, pw){
  var msg = $('loginMsg');
  msg.className = 'login-msg';
  msg.innerHTML = '<span class="spin"></span> 확인 중…';
  NAME = name;
  PW = pw;
  return api('bootstrap').then(function(b){
    try{ localStorage.setItem(PW_KEY, pw); localStorage.setItem(NAME_KEY, name); }catch(e){}
    b.people = arr(b.people); b.projects = arr(b.projects);
    b.categories = arr(b.categories); b.payments = arr(b.payments);
    b.trips = arr(b.trips);
    BOOT = b;
    $('login').hidden = true;
    $('app').hidden = false;
    start();
  }).catch(function(e){
    NAME = ''; PW = '';
    msg.className = 'login-msg err';
    msg.textContent = e.message;
    throw e;
  });
}

function start(){
  $('sheetLink').href = BOOT.sheetUrl || '#';
  $('driveLink').href = BOOT.driveUrl || '#';
  $('payment').innerHTML = BOOT.payments.map(function(p){
    return '<option>' + esc(p) + '</option>';
  }).join('');
  $('ocrHint').textContent = BOOT.ocrAvailable
    ? '등록하면 자동으로 읽습니다' : '자동 인식 꺼짐 · 직접 입력';

  var ctx = loadCtx();
  selectedProject = ctx.project || '';
  if(ctx.payment) $('payment').value = ctx.payment;
  curTripId = ctx.tripId || (BOOT.trips.length ? BOOT.trips[0].id : '');

  renderCatChips(); renderProjectChips(); renderFilterChips(); renderKindChips(); renderMemberChips();
  renderNoTripWarn(); renderEditBanner(); syncPayerBox();
  loadTripForm(curTripId);
  syncNetbar();
  refreshQueueBadge().then(function(){ return flushQueue(true); });
  refresh();
}

function init(){
  $('date').value = today();
  renderPhotoButtons();

  document.querySelectorAll('.tab').forEach(function(tab){
    tab.onclick = function(){ gotoTab(tab.dataset.page); };
  });

  ['cameraFile','galleryFile'].forEach(function(id){
    $(id).onchange = function(e){ handlePickedFile(e.target.files && e.target.files[0]); };
  });
  document.addEventListener('paste', function(e){
    if($('app').hidden) return;
    if(!$('page-input').classList.contains('on')) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for(var i = 0; i < items.length; i++){
      if(items[i].type && items[i].type.indexOf('image') === 0){
        var f = items[i].getAsFile();
        if(f){ e.preventDefault(); toast('캡처 이미지를 불러왔습니다'); handlePickedFile(f); }
        return;
      }
    }
  });

  $('amount').oninput = function(){
    var d = digits(this.value);
    this.value = d ? comma(d) : '';
    markField('amount', '');
    recalcPerHead();
  };
  $('people').oninput = recalcPerHead;
  $('date').onchange = function(){ markField('date', ''); };
  $('detail').oninput = function(){ markField('detail', ''); };
  $('payment').onchange = function(){ syncPayerBox(); saveCtx(); };

  $('saveBtn').onclick = saveExpense;
  $('deleteBtn').onclick = deleteExpense;
  $('resetBtn').onclick = function(){
    clearEntry(true);
    selectedCategory = '';
    renderCatChips();
    toast('입력란을 비웠습니다');
  };
  $('search').oninput = renderList;
  $('queueBtn').onclick = showQueue;

  $('tripSelect').onchange = function(){
    loadTripForm(this.value);
    if(this.value){ curTripId = this.value; saveCtx(); renderProjectChips(); refresh(); }
  };
  $('tStart').onchange = autoDays;
  $('tEnd').onchange = autoDays;
  $('tMonth').onchange = function(){
    var v = this.value;   // "yyyy-mm"
    if(!v) return;
    var parts = v.split('-');
    var y = Number(parts[0]), mo = Number(parts[1]);
    var last = new Date(y, mo, 0).getDate();   // 그 달의 마지막 날
    $('tStart').value = v + '-01';
    $('tEnd').value = v + '-' + (last < 10 ? '0' + last : last);
    $('tDays').value = last;
    $('tNights').value = 0;
    renderTripNamePreview();
    renderLimitCalc();
  };
  $('tDays').oninput = renderLimitCalc;
  $('tNights').oninput = renderLimitCalc;
  $('tripSaveBtn').onclick = saveTrip;
  $('planBtn').onclick = function(){ makeDoc('tripPlan'); };
  $('reportBtn').onclick = function(){ makeDoc('tripReport'); };

  $('loginBtn').onclick = function(){
    var n = $('nameInput').value.trim();
    var v = $('pwInput').value.trim();
    if(!n){ $('loginMsg').className='login-msg err'; $('loginMsg').textContent='이름을 입력하세요.'; return; }
    if(!v){ $('loginMsg').className='login-msg err'; $('loginMsg').textContent='암호를 입력하세요.'; return; }
    doLogin(n, v).catch(function(){});
  };
  $('nameInput').onkeydown = function(e){ if(e.key === 'Enter') $('pwInput').focus(); };
  $('pwInput').onkeydown = function(e){ if(e.key === 'Enter') $('loginBtn').click(); };

  window.addEventListener('online', function(){ syncNetbar(); flushQueue(); });
  window.addEventListener('offline', syncNetbar);
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && PW) flushQueue(true);
  });

  // 저장된 이름·암호가 있으면 바로 들어간다
  var savedName = '', saved = '';
  try{ savedName = localStorage.getItem(NAME_KEY) || ''; saved = localStorage.getItem(PW_KEY) || ''; }catch(e){}
  if(savedName && saved){
    $('nameInput').value = savedName;
    $('pwInput').value = saved;
    doLogin(savedName, saved).catch(function(e){
      if(e && e.authFailed){ try{ localStorage.removeItem(PW_KEY); localStorage.removeItem(NAME_KEY); }catch(x){} }
      $('pwInput').value = '';
    });
  }

  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('./sw.js').catch(function(){});
    });
  }
}

init();
