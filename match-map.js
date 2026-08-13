/* ============================================================
   YAKINDAKİLER HARİTASI — "match-map.js"
   ------------------------------------------------------------
   Snap Map benzeri, arkadaşların gerçek zamanlı konumunu gösteren
   harita özelliği. index.html'deki global değişken/fonksiyonlara
   (fbAuth, fbDb, requireFirebase, t, currentLang, showToast,
   escapeHtml, isMutuallyBlocked, formatPostAge, startChatWith,
   makeChatId, ensureChatMeta, savedUsername, savedProfilePhoto,
   savedVerifiedTier, openVerifiedBadgeInfo, closeTopmostOverlay
   listesi vb.) dayanır — bu dosya index.html'den SONRA yüklenmeli.

   Firebase veri şeması: userLocations/{uid}
     lat, lng        — gerçek koordinat
     sharing         — true değilse harita hiç göstermez
     ghostMode       — true ise kişi görünmez ama başkalarını görür
     updatedAt       — son güncelleme zamanı (ms epoch)
     heading         — hareket yönü, derece (Araba Modu)
     visibility      — 'public' | 'mutual' | 'except'
     excludedUids    — { [uid]: true } — 'except' modunda hariç tutulanlar
     trackMode       — 'normal' | 'battery' | 'car'
     msgApprovalOn   — mesaj onayı tercihi (varsayılan: true)
   ============================================================ */

/* ---------- AYARLAR ---------- */
// KENDİ Mapbox erişim token'ını buraya yaz: https://account.mapbox.com/access-tokens/
const MAPBOX_ACCESS_TOKEN = 'pk.eyJ1IjoidGFseGFlIiwiYSI6ImNtc2wyNTBidjE1Nm0yeXF6Z2h5d2plMzUifQ.qqsum3zJ-Swis6YN8LMOkA';
const MATCH_MAP_MAX_DISTANCE_KM = 100;
const MATCH_MAP_MAX_RESULTS = 60;
const MATCH_MAP_STYLES = {
  dark: 'mapbox://styles/mapbox/standard',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};
const MATCH_MAP_3D_PITCH = 55; // Standard stildeki 3D binalar için sabit, kontrollü açı

/* ---------- DURUM ---------- */
let matchMap = null;
let matchMapStyleKey = 'dark';
let matchMapMarkers = {};              // uid -> SnapAvatarMarker
let matchMapMyLoc = null;              // {lat,lng}
let matchMapWatchId = null;
let matchMapRefreshTimer = null;
let matchMapMySettings = { sharing:false, ghostMode:false, visibility:'public', excludedUids:{}, onlyUids:{}, trackMode:'normal', msgApprovalOn:true };
let matchMapSelectedUid = null;
let matchMapFollowSetCache = null;     // {follows:Set, followers:Set}
let matchMapLoadToken = 0;             // eşzamanlı yükleme yarışını önlemek için

/* ---------- YARDIMCI: Haversine mesafe (km) ----------
   Not: uygulamanın başka bir yerinde (konum etiketi özelliğinde)
   haversineKm() tanımsız olarak çağrılıyordu — burada global olarak
   tanımlanınca o eksik de giderilmiş oluyor. */
if(typeof window.haversineKm !== 'function'){
  window.haversineKm = function haversineKm(lat1, lon1, lat2, lon2){
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };
}

/* ============================================================
   STİL — bu dosyanın ihtiyaç duyduğu tüm CSS'i kendisi enjekte eder
   ============================================================ */
(function injectMatchMapStyles(){
  const css = `
  #matchMapOverlay{position:fixed;inset:0;z-index:9500;background:#000;display:flex;flex-direction:column;}
  #matchMapOverlay.hidden{display:none;}
  #matchMapCanvas{position:absolute;inset:0;}
  .matchMapTopBar{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;justify-content:space-between;
    padding:calc(env(safe-area-inset-top,0px) + 14px) 14px 10px;pointer-events:none;}
  .matchMapTopBar > *{pointer-events:auto;}
  .matchMapIconBtn{width:40px;height:40px;border-radius:50%;background:var(--glass-bg);backdrop-filter:blur(10px);
    border:1px solid var(--glass-border);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--glass-shadow);}
  .matchMapTitle{color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;text-shadow:0 1px 6px rgba(0,0,0,.5);}
  .matchMapRightBtns{display:flex;gap:8px;}
  .matchMapStyleToggleBtn{display:flex;align-items:center;gap:6px;padding:9px 16px 9px 12px;border-radius:22px;background:rgba(24,27,38,.72);
    backdrop-filter:blur(10px);border:1px solid #3A4756;color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
  .matchMapFloatingLocBtn{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 20px);right:16px;z-index:2;
    width:46px;height:46px;border-radius:50%;background:#A855F7;box-shadow:0 4px 18px rgba(168,85,247,.55);
    border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
  .matchMapEmptyHint{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;color:#fff;text-align:center;
    background:rgba(5,2,15,.6);backdrop-filter:blur(6px);padding:16px 22px;border-radius:16px;font-size:13px;max-width:260px;pointer-events:none;}

  /* SnapAvatarMarker — sabit piksel boyutu, zoom'dan bağımsız */
  .snapAvatarMarker{width:50px;height:92px;display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;}
  .snapMarkerName{max-width:70px;font-size:10px;font-weight:700;color:#fff;background:rgba(5,2,15,.55);padding:2px 6px;border-radius:8px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;text-align:center;}
  .snapMarkerRing{width:46px;height:46px;border-radius:50%;padding:2.5px;background:var(--ring-color,#8b5cf6);
    box-shadow:0 0 10px 2px var(--ring-color,#8b5cf6), 0 0 0 2px rgba(0,0,0,.35);position:relative;}
  .snapMarkerRing img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;border:2px solid #0a0a0f;}
  .snapMarkerHeadingArrow{position:absolute;top:-9px;left:50%;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;
    border-bottom:9px solid var(--ring-color,#8b5cf6);transform-origin:50% 28px;filter:drop-shadow(0 0 3px rgba(0,0,0,.5));}
  .snapMarkerShadow{width:22px;height:6px;border-radius:50%;background:rgba(0,0,0,.45);filter:blur(1.5px);margin-top:3px;}
  .snapMarkerTime{font-size:9px;color:#d8d3ee;margin-top:2px;text-shadow:0 1px 3px rgba(0,0,0,.7);white-space:nowrap;}
  .snapAvatarMarker.is-me .snapMarkerRing{box-shadow:0 0 14px 3px #fff, 0 0 0 2px rgba(0,0,0,.35);}

  /* Aynı konumdaki birden fazla kişi — yığın (cluster) işaretçisi */
  .snapClusterMarker{display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;}
  .snapClusterName{font-size:11px;font-weight:700;color:#fff;background:linear-gradient(135deg,#FF4D6D,#FF2A55);padding:4px 12px;border-radius:12px;white-space:nowrap;margin-top:6px;box-shadow:0 2px 8px rgba(255,42,85,.4);}
  .snapClusterStack{display:flex;align-items:center;}
  .snapClusterAvatar{width:38px;height:38px;border-radius:50%;object-fit:cover;border:2.5px solid #0a0a0f;box-shadow:0 0 8px rgba(139,92,246,.5);}
  .snapClusterExtra{width:38px;height:38px;border-radius:50%;background:var(--gradient-vivid);color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:11.5px;font-weight:800;border:2.5px solid #0a0a0f;margin-left:-14px;}
  .matchClusterRow{display:flex;align-items:center;gap:12px;padding:11px 20px;cursor:pointer;}
  .matchClusterRow:hover{background:var(--surface-2);}
  .matchClusterRow img{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;}

  /* Profil önizleme / ayarlar — mevcut followListOverlay/Sheet düzenini kullanır */
  .matchProfilePhotoBig{width:100%;aspect-ratio:1/1;max-height:280px;object-fit:cover;background:var(--surface-2);}
  .matchLockedBlur{filter:blur(14px);pointer-events:none;user-select:none;}
  .matchLockOverlayBox{position:relative;}
  .matchLockBadge{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
    background:rgba(5,2,15,.35);text-align:center;padding:14px;}
  .matchSettingsRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);}
  .matchSettingsRow .lbl{font-size:13.5px;font-weight:600;color:var(--text);}
  .matchSettingsRow .desc{font-size:11.5px;color:var(--muted);margin-top:2px;line-height:1.4;}
  .matchSwitch{position:relative;width:44px;height:26px;border-radius:14px;background:var(--surface-2);border:1px solid var(--line);cursor:pointer;flex-shrink:0;transition:background .15s;}
  .matchSwitch.on{background:var(--gradient-vivid);border-color:transparent;}
  .matchSwitch .knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 3px rgba(0,0,0,.3);}
  .matchSwitch.on .knob{transform:translateX(18px);}

  /* Hayalet Modu / Mesaj Onayı — görsel referanstaki bağımsız yuvarlak kartlar */
  .matchSettingsCard{display:flex;align-items:center;justify-content:space-between;gap:14px;background:var(--surface-2);
    border-radius:18px;padding:16px 18px;margin-bottom:14px;}
  .matchSettingsCard .lbl{font-size:15px;font-weight:700;color:var(--text);}
  .matchSettingsCard .desc{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5;}

  /* Konumumu Kimler Görebilir / Takip Modu — tek kart içinde gruplu satırlar */
  .matchVisGroupCard{background:var(--surface-2);border-radius:18px;overflow:hidden;}
  .matchVisOption{display:flex;align-items:center;gap:10px;padding:15px 18px;cursor:pointer;border-bottom:1px solid var(--line);}
  .matchVisOption:last-child{border-bottom:none;}
  .matchVisOption .lbl{color:var(--text);}
  .matchVisOption .desc{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.4;}
  .matchVisOption .dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex-shrink:0;position:relative;display:flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s;}
  .matchVisOption.selected .dot,.matchVisOption .dot.selected-dot{background:#22C55E;border-color:#22C55E;}
  .matchVisOption.selected .dot::after,.matchVisOption .dot.selected-dot::after{content:'';width:11px;height:6px;border-left:2.5px solid #fff;border-bottom:2.5px solid #fff;
    transform:rotate(-45deg) translateY(-1px);}

  /* Konum Paylaşımını Kapat — görsel referanstaki gibi çerçeveli/yarı saydam kırmızı */
  .matchStopSharingBtn{width:100%;padding:15px;border-radius:16px;border:1.5px solid var(--danger);background:rgba(237,73,86,.12);
    color:var(--danger);font-weight:800;font-size:14.5px;cursor:pointer;font-family:'Space Grotesk',sans-serif;}

  .matchExcludeChip{padding:6px 12px;border-radius:14px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--text);}
  .matchExcludeChip.excluded{background:var(--danger);border-color:var(--danger);color:#fff;}
  .mapboxgl-marker{will-change:transform;}

  /* Ana akıştaki "Yakındakiler" ikonu — yavaşça kalp atışı gibi nabız
     atarak dikkat çeksin. İnsan nabzına yakın bir ritim: kısa çift vuruş,
     sonra dinlenme. */
  @keyframes matchMapHeartbeat{
    0%   { transform:scale(1);    }
    14%  { transform:scale(1.16); }
    28%  { transform:scale(1);    }
    42%  { transform:scale(1.12); }
    56%  { transform:scale(1);    }
    100% { transform:scale(1);    }
  }
  @keyframes matchMapHeartbeatGlow{
    0%   { box-shadow:0 0 0 0 rgba(168,85,247,.55); }
    28%  { box-shadow:0 0 0 8px rgba(168,85,247,0); }
    100% { box-shadow:0 0 0 0 rgba(168,85,247,0); }
  }
  .matchMapNavPulse{
    animation: matchMapHeartbeat 2.6s ease-in-out infinite, matchMapHeartbeatGlow 2.6s ease-in-out infinite;
    border-radius:50%;
  }
  `;
  const style = document.createElement('style');
  style.id = 'matchMapInjectedStyles';
  style.textContent = css;
  document.head.appendChild(style);
})();

/* ============================================================
   GİRİŞ NOKTASI
   ============================================================ */
function openMatchMap(){
  if(!requireFirebase() || !fbAuth.currentUser){ showToast(t('toast_login_required') || 'Giriş yapmalısın.'); return; }
  const myUid = fbAuth.currentUser.uid;
  fbDb.ref('userLocations/' + myUid + '/sharing').once('value').then(snap=>{
    if(snap.val() === true){
      openMatchMapOverlay();
    } else {
      showMatchConsentModal();
    }
  }).catch(()=> showToast(t('toast_generic_error') || 'Bir şeyler ters gitti.'));
}

/* ---------- Onam (consent) modalı — konum paylaşımı ilk kez açılırken ---------- */
function showMatchConsentModal(){
  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchConsentOverlay';
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchConsentModal(); };
  document.body.classList.add('follow-list-open');
  overlay.innerHTML = `
    <div class="followListSheet">
      <div class="followListHead">
        <h3>🗺️ ${escapeHtml(t('match_consent_title'))}</h3>
        <button class="followListClose" onclick="closeMatchConsentModal()">✕</button>
      </div>
      <div class="followListBody" style="padding:6px 20px 20px;">
        <p style="font-size:13px;line-height:1.6;color:var(--text);margin:6px 0 18px;">${escapeHtml(t('match_consent_body'))}</p>
        <button class="btn btn-primary" style="width:100%;margin-bottom:10px;" onclick="acceptMatchConsent()">${escapeHtml(t('match_consent_accept'))}</button>
        <button class="btn btn-ghost" style="width:100%;" onclick="closeMatchConsentModal()">${escapeHtml(t('match_consent_cancel'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeMatchConsentModal(){
  const ov = document.getElementById('matchConsentOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}
function acceptMatchConsent(){
  closeMatchConsentModal();
  enableMatchLocationSharing();
}

/* ---------- Konum paylaşımını aç ve haritayı başlat ---------- */
function enableMatchLocationSharing(){
  if(!navigator.geolocation){ showToast(t('toast_no_geo')); return; }
  const myUid = fbAuth.currentUser.uid;
  showToast(t('toast_loc_loading'));
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      const { latitude, longitude, heading } = pos.coords;
      matchMapMyLoc = { lat: latitude, lng: longitude };
      matchMapMySettings.sharing = true;
      fbDb.ref('userLocations/' + myUid).update({
        lat: latitude, lng: longitude,
        heading: heading || 0,
        sharing: true, ghostMode: false,
        visibility: matchMapMySettings.visibility || 'public',
        trackMode: matchMapMySettings.trackMode || 'normal',
        updatedAt: Date.now()
      }).then(()=>{
        startMatchLocationWatch(matchMapMySettings.trackMode || 'normal');
        openMatchMapOverlay();
      }).catch(()=> showToast(t('toast_generic_error') || 'Konum kaydedilemedi.'));
    },
    ()=>{ showToast(t('toast_loc_denied')); },
    { enableHighAccuracy:true, timeout:12000, maximumAge:60000 }
  );
}

/* ---------- Konum takibi: Normal (bir kez) / Tasarruf (seyrek) / Araba (sürekli) ---------- */
function startMatchLocationWatch(mode){
  stopMatchLocationWatch();
  if(!navigator.geolocation || !fbAuth.currentUser) return;
  const myUid = fbAuth.currentUser.uid;
  const writeLoc = (pos)=>{
    const { latitude, longitude, heading } = pos.coords;
    matchMapMyLoc = { lat: latitude, lng: longitude };
    const update = { lat: latitude, lng: longitude, updatedAt: Date.now() };
    if(mode === 'car') update.heading = (heading === null || isNaN(heading)) ? 0 : heading;
    fbDb.ref('userLocations/' + myUid).update(update).catch(()=>{});
    if(matchMap && matchMapMarkers['__me__']) matchMapMarkers['__me__'].updatePosition(longitude, latitude);
  };
  if(mode === 'car'){
    matchMapWatchId = navigator.geolocation.watchPosition(writeLoc, ()=>{}, { enableHighAccuracy:true, maximumAge:5000 });
  } else if(mode === 'battery'){
    writeLoc({ coords: { latitude: matchMapMyLoc ? matchMapMyLoc.lat : 0, longitude: matchMapMyLoc ? matchMapMyLoc.lng : 0 } });
    matchMapRefreshTimer = setInterval(()=>{
      navigator.geolocation.getCurrentPosition(writeLoc, ()=>{}, { enableHighAccuracy:false, timeout:15000, maximumAge:120000 });
    }, 5 * 60000); // 5 dakikada bir
  } else {
    // normal: haritayı her açtığında bir kez alınır (zaten enableMatchLocationSharing/openMatchMapOverlay içinde alınıyor)
  }
}
function stopMatchLocationWatch(){
  if(matchMapWatchId !== null){ navigator.geolocation.clearWatch(matchMapWatchId); matchMapWatchId = null; }
  if(matchMapRefreshTimer){ clearInterval(matchMapRefreshTimer); matchMapRefreshTimer = null; }
}

/* ============================================================
   HARİTA ÜST KATMANI (overlay) — açma / kapama
   ============================================================ */
function openMatchMapOverlay(){
  let overlay = document.getElementById('matchMapOverlay');
  if(!overlay){
    overlay = document.createElement('div');
    overlay.id = 'matchMapOverlay';
    overlay.className = 'followListOverlay-ignore'; // özel tam ekran overlay, followListOverlay davranışını KULLANMIYORUZ
    overlay.innerHTML = `
      <div id="matchMapCanvas"></div>
      <div class="matchMapTopBar">
        <button class="matchMapIconBtn" onclick="closeMatchMapOverlay()" title="${escapeHtml(t('match_back'))}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div class="matchMapTitle">${escapeHtml(t('match_nearby_title'))}</div>
        <div class="matchMapRightBtns">
          <button class="matchMapStyleToggleBtn" id="matchMapStyleToggleBtn" onclick="toggleMatchMapStyleMode()"></button>
          <button class="matchMapIconBtn" onclick="openMatchSettings()" title="${escapeHtml(t('match_settings_title'))}">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019 9c.14.36.22.75.22 1.15"/></svg>
          </button>
        </div>
      </div>
      <button class="matchMapFloatingLocBtn" onclick="goToMyMatchLocation()" title="${escapeHtml(t('match_my_location'))}">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L4 21l8-4 8 4z"/></svg>
      </button>
      <div class="matchMapEmptyHint hidden" id="matchMapEmptyHint">${escapeHtml(t('toast_no_one_nearby'))}</div>
    `;
    document.body.appendChild(overlay);
    Object.assign(overlay.style, { position:'fixed', inset:'0', zIndex:9500, background:'#000', display:'flex', flexDirection:'column' });
  }
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
  document.getElementById('island')?.classList.add('hidden');

  loadMatchMapSettingsThenInit();
}

function closeMatchMapOverlay(){
  const overlay = document.getElementById('matchMapOverlay');
  if(overlay){ overlay.style.display = 'none'; }
  document.getElementById('island')?.classList.remove('hidden');
  // Not: harita kapansa da, "Normal" mod dışında konum takibi arka planda
  // devam eder (Tasarruf/Araba modu kasıtlı olarak böyle çalışır).
}

/* closeTopmostOverlay() listesine elle kaydolmadan da kapanabilsin diye
   burada global bir yardımcı bırakıyoruz — index.html'deki closer
   listesine `['matchMapOverlay', ()=>closeMatchMapOverlay()]` eklenmiştir. */

/* ---------- Ayarları oku, sonra haritayı kur ---------- */
function loadMatchMapSettingsThenInit(){
  const myUid = fbAuth.currentUser.uid;
  fbDb.ref('userLocations/' + myUid).once('value').then(snap=>{
    const d = snap.val() || {};
    matchMapMySettings = {
      sharing: d.sharing === true,
      ghostMode: d.ghostMode === true,
      visibility: d.visibility || 'public',
      excludedUids: d.excludedUids || {},
      onlyUids: d.onlyUids || {},
      trackMode: d.trackMode || 'normal',
      msgApprovalOn: d.msgApprovalOn !== false
    };
    if(typeof d.lat === 'number' && typeof d.lng === 'number') matchMapMyLoc = { lat:d.lat, lng:d.lng };
    initMatchMapInstance();
  });
}

/* ============================================================
   MAPBOX GL — HARİTA KURULUMU
   ============================================================ */
function initMatchMapInstance(){
  if(typeof mapboxgl === 'undefined'){
    showToast("Mapbox GL JS yüklenemedi. index.html'e CDN scriptini eklediğinden emin ol.");
    return;
  }
  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
  const center = matchMapMyLoc ? [matchMapMyLoc.lng, matchMapMyLoc.lat] : [35.2433, 38.9637]; // varsayılan: Türkiye ortası

  if(matchMap){
    // Zaten kurulu — sadece merkezle ve yeniden yükle
    matchMap.setCenter(center);
    refreshNearbyMatchUsers();
    return;
  }

  matchMap = new mapboxgl.Map({
    container: 'matchMapCanvas',
    style: MATCH_MAP_STYLES[matchMapStyleKey] || MATCH_MAP_STYLES.dark,
    center, zoom: 15, pitch: matchMapMyLoc ? MATCH_MAP_3D_PITCH : 0, bearing: 0, attributionControl: false,
    minZoom: 0.9,              // küre görünümü kalsın, ekrana tam sığacak kadar uzaklaşabilsin
    pitchWithRotate: false,   // iki parmakla sürükleyerek eğme (tilt) kapalı — açı SADECE kod tarafından, sabit ve kontrollü
    dragRotate: false,        // sağ tık / iki parmak sürükleyerek döndürme kapalı
    touchPitch: false         // iki parmak dikey kaydırmayla eğme kapalı
  });
  // Ekstra güvence: pinch (sıkıştırma) hareketiyle gelen döndürmeyi de kapat —
  // kullanıcı elle eğip/döndürüp "eski haline döndüremem" durumuna hiç
  // düşmesin; 3D açı sadece BİZİM kodumuzun belirlediği sabit bir değer.
  matchMap.touchZoomRotate.disableRotation();
  matchMap.on('load', ()=>{
    applyMatchMap3DTheme();
    applyMatchMapColorPalette();
    applyMatchMapHolidayTheme();
    // Konum henüz gelmemişken harita varsayılan (Türkiye ortası) merkezle
    // açılmış olabilir — gerçek konum eldeyse sokak seviyesinde ortalayarak
    // asla geniş/uzak bir dünya görünümünde takılı kalmamasını sağlıyoruz.
    if(matchMapMyLoc){
      matchMap.jumpTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 15, pitch: MATCH_MAP_3D_PITCH, bearing: 0 });
    }
    refreshNearbyMatchUsers();
    // İlk açılışta harita kutusu tam boyutuna henüz oturmamış olabilir
    // (overlay animasyonu vb.), bu da piksel hesaplarını yanlış çıkarıp
    // kümelemenin ilk seferde devreye girmemesine yol açabiliyor. Harita
    // tamamen "idle" (durgun/hazır) olduğunda bir kez daha kesin ölçülerle
    // yeniden çiziyoruz.
    matchMap.resize();
    matchMap.once('idle', ()=>{ renderAllMatchMarkers(matchMapLastCandidates || []); });
  });
  // Zoom seviyesi değişince (yakınlaş/uzaklaş) piksel mesafeleri değişir —
  // yığınları (kimin kiminle üst üste bindiğini) yeniden hesaplamamız gerekir.
  // Ayrıca açıyı (pitch) da zoom'a göre otomatik ayarlıyoruz: küre/dünya
  // görünümünde (uzak zoom) düz durmalı — eğik bir küre garip görünüyor.
  // Sadece şehir/sokak seviyesinde (yakın zoom) 3D açı uygulanıyor.
  matchMap.on('zoomend', ()=>{
    renderAllMatchMarkers(matchMapLastCandidates || []);
    const z = matchMap.getZoom();
    const wantPitch = (matchMapStyleKey === 'dark' && z >= 4) ? MATCH_MAP_3D_PITCH : 0;
    if(Math.abs(matchMap.getPitch() - wantPitch) > 1){
      matchMap.easeTo({ pitch: wantPitch, duration: 400 });
    }
  });
  updateMatchMapStyleToggleUI();
}

/* Mapbox Standard stilinin kendi gece temasını (lightPreset) uygular —
   klasik dark-v11'deki gibi elle katman katman boyamak yerine, Standard
   stilin yerleşik "night" ışık ayarını kullanıyoruz. Uydu modunda (raster
   gerçek görüntü) bu ayarın etkisi yok, güvenle atlanır. */
function applyMatchMap3DTheme(){
  if(!matchMap || matchMapStyleKey !== 'dark') return;
  try{
    matchMap.setConfigProperty('basemap', 'lightPreset', 'night');
    matchMap.setConfigProperty('basemap', 'show3dObjects', true);
  }catch(e){ /* Standard stil henüz desteklemiyorsa sessizce yok say */ }
}

/* Uydu ⇄ Koyu tek buton üzerinden değişir (Snapchat'teki gibi) — buton her
   zaman GEÇİLECEK modu gösterir: koyu haritadayken "🛰️ Uydu" yazar,
   uyduyken "🌙 Koyu" yazar. */
function toggleMatchMapStyleMode(){
  matchMapStyleKey = matchMapStyleKey === 'dark' ? 'satellite' : 'dark';
  updateMatchMapStyleToggleUI();
  if(!matchMap) return;
  matchMap.setStyle(MATCH_MAP_STYLES[matchMapStyleKey]);
  matchMap.setPitch(matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0);
  matchMap.once('style.load', ()=>{
    applyMatchMap3DTheme();
    applyMatchMapColorPalette();
    applyMatchMapHolidayTheme();
    renderAllMatchMarkers(matchMapLastCandidates || []);
  });
}
function updateMatchMapStyleToggleUI(){
  const btn = document.getElementById('matchMapStyleToggleBtn');
  if(!btn) return;
  // Buton, geçiş yapılacak SONRAKİ modu gösterir
  btn.innerHTML = matchMapStyleKey === 'dark' ? escapeHtml(t('match_style_satellite')) : escapeHtml(t('match_style_dark'));
}

function goToMyMatchLocation(){
  if(!matchMap || !matchMapMyLoc) return;
  matchMap.flyTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 15, pitch: matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0, bearing: 0 });
}

/* ============================================================
   ÖZEL RENK PALETİ — Deep Midnight Blue / neon mor-pembe tema
   Mapbox'ın hazır "dark-v11" stilini, verilen HEX paletine göre
   katman katman yeniden renklendirir (Mapbox Studio'ya ihtiyaç
   duymadan, istemci tarafında setPaintProperty ile). Uydu modunda
   (raster gerçek görüntü) renk override edilmez, olduğu gibi kalır. */
const MATCH_MAP_PALETTE = {
  bg: '#181B26',
  bgAlt: '#12151E',
  land: '#232B35',
  water: '#2C3540',
  roadThin: '#3A4756',
  roadMain: '#4B596B',
  text: '#FFFFFF'
};
function applyMatchMapColorPalette(){
  // NOT: Bu fonksiyon eski klasik "dark-v11" stili için katman katman
  // elle renk zorlardı. Artık "dark" anahtarı Mapbox'ın yeni Standard
  // (3D) stiline işaret ediyor — o stil klasik paint-property overrides
  // ile uyumlu değil, zorlayınca tuhaf/yanlış renkler çıkıyordu. Standard
  // stilin teması artık applyMatchMap3DTheme() içindeki lightPreset ile
  // yönetiliyor; bu fonksiyon şimdilik devre dışı bırakıldı.
  return;
}
function applyMatchMapColorPalette_LEGACY_UNUSED(){
  if(!matchMap || matchMapStyleKey !== 'dark') return;
  let layers = [];
  try{ layers = matchMap.getStyle().layers || []; }catch(e){ return; }
  layers.forEach(layer=>{
    const id = (layer.id || '').toLowerCase();
    const src = (layer['source-layer'] || '').toLowerCase();
    const key = id + ' ' + src;
    try{
      if(layer.type === 'background'){
        matchMap.setPaintProperty(layer.id, 'background-color', MATCH_MAP_PALETTE.bg);
      } else if(layer.type === 'fill'){
        if(key.includes('water')) matchMap.setPaintProperty(layer.id, 'fill-color', MATCH_MAP_PALETTE.water);
        else if(key.includes('building')) matchMap.setPaintProperty(layer.id, 'fill-color', MATCH_MAP_PALETTE.bgAlt);
        else if(key.includes('land') || key.includes('park') || key.includes('landuse') || key.includes('wood') || key.includes('vegetation') || key.includes('grass'))
          matchMap.setPaintProperty(layer.id, 'fill-color', MATCH_MAP_PALETTE.land);
      } else if(layer.type === 'line'){
        if(key.includes('road') || key.includes('bridge') || key.includes('tunnel')){
          const isMajor = key.includes('motorway') || key.includes('trunk') || key.includes('primary');
          matchMap.setPaintProperty(layer.id, 'line-color', isMajor ? MATCH_MAP_PALETTE.roadMain : MATCH_MAP_PALETTE.roadThin);
        } else if(key.includes('water') || key.includes('river') || key.includes('stream')){
          matchMap.setPaintProperty(layer.id, 'line-color', MATCH_MAP_PALETTE.water);
        }
      } else if(layer.type === 'symbol'){
        matchMap.setPaintProperty(layer.id, 'text-color', MATCH_MAP_PALETTE.text);
        matchMap.setPaintProperty(layer.id, 'text-halo-color', MATCH_MAP_PALETTE.bgAlt);
      }
    }catch(e){ /* bu katman ilgili boya özelliğini desteklemiyor olabilir — yok say */ }
  });
}

/* ---------- Bayram teması (appConfig/mapTheme) — hafif dekoratif filtre ---------- */
function applyMatchMapHolidayTheme(){
  const canvas = document.getElementById('matchMapCanvas');
  if(!canvas) return;
  canvas.style.filter = '';
  fbDb.ref('appConfig/mapTheme').once('value').then(snap=>{
    const cfg = snap.val() || {};
    let themeId = '';
    if(cfg.mode === 'manual'){
      themeId = cfg.themeId || '';
    } else {
      themeId = detectAutoHolidayTheme();
    }
    const filters = {
      newyear: 'hue-rotate(190deg) saturate(1.15)',
      ramadan: 'sepia(.25) saturate(1.1)',
      halloween: 'hue-rotate(-40deg) saturate(1.3) brightness(.92)',
      easter: 'saturate(1.2) brightness(1.05)'
    };
    if(filters[themeId]) canvas.style.filter = filters[themeId];
  }).catch(()=>{});
}
function detectAutoHolidayTheme(){
  const now = new Date();
  const m = now.getMonth() + 1, d = now.getDate();
  if(m === 12 && d >= 15) return 'newyear';
  if(m === 1 && d <= 2) return 'newyear';
  if(m === 10 && d >= 24 && d <= 31) return 'halloween';
  return '';
}

/* ============================================================
   VERİ ÇEKME & FİLTRELEME — loadNearbyMatchUsers()
   Adımlar:
   1. Kendini listeden çıkar
   2. sharing!==true veya ghostMode===true olanları çıkar
   3. Engellenen/engelleyen kullanıcıları çıkar
   4. visibility: mutual/except için karşılıklı takip kontrolü
   5. 100 km'den uzak olanları ele, en yakın 60 kişiyi al
   ============================================================ */
let matchMapLastCandidates = [];

function loadNearbyMatchUsers(){
  const myUid = fbAuth.currentUser.uid;
  return Promise.all([
    fbDb.ref('userLocations').once('value'),
    fbDb.ref('follows/' + myUid).once('value'),
    fbDb.ref('followers/' + myUid).once('value')
  ]).then(([allSnap, myFollowsSnap, myFollowersSnap])=>{
    if(!matchMapMyLoc) return [];
    const myFollows = new Set(Object.keys(myFollowsSnap.val() || {}));     // ben kimi takip ediyorum
    const myFollowers = new Set(Object.keys(myFollowersSnap.val() || {})); // beni kim takip ediyor
    const all = allSnap.val() || {};
    const candidates = [];

    Object.keys(all).forEach(uid=>{
      if(uid === myUid) return;                                           // 1) kendini çıkar
      const loc = all[uid];
      if(!loc || loc.sharing !== true || loc.ghostMode === true) return;  // 2) paylaşmayan/hayalet modda olan
      if(typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
      if(isMutuallyBlocked(uid)) return;                                  // 3) engelli ilişki

      const isMutual = myFollows.has(uid) && myFollowers.has(uid);
      const vis = loc.visibility || 'public';
      if(vis === 'public'){
        // herkese açık — ek şart yok, sadece 3'te elenen engel ilişkisi geçerli
      } else if(vis === 'mutual'){
        if(!isMutual) return;                                             // 4) karşılıklı takip şartı
      } else if(vis === 'except'){
        if(!isMutual) return;
        if((loc.excludedUids || {})[myUid]) return;                       // beni hariç tutmuş
      } else if(vis === 'only'){
        if(!isMutual) return;
        if(!(loc.onlyUids || {})[myUid]) return;                          // beni seçili listeye eklememiş
      } else {
        return; // tanımsız değer — güvenli taraf: gösterme
      }

      const dist = haversineKm(matchMapMyLoc.lat, matchMapMyLoc.lng, loc.lat, loc.lng);
      if(dist > MATCH_MAP_MAX_DISTANCE_KM) return;                        // 5) mesafe sınırı
      candidates.push({ uid, loc, dist });
    });

    candidates.sort((a, b)=> a.dist - b.dist);
    return candidates.slice(0, MATCH_MAP_MAX_RESULTS);                    // 5) en yakın 60
  });
}

function refreshNearbyMatchUsers(){
  const token = ++matchMapLoadToken;
  loadNearbyMatchUsers().then(candidates=>{
    if(token !== matchMapLoadToken) return; // eskimiş istek, yok say
    matchMapLastCandidates = candidates;
    const emptyHint = document.getElementById('matchMapEmptyHint');
    if(emptyHint) emptyHint.classList.toggle('hidden', candidates.length > 0);
    return fetchProfilesFor(candidates.map(c=>c.uid)).then(profiles=>{
      candidates.forEach(c=>{ c.profile = profiles[c.uid] || {}; });
      renderAllMatchMarkers(candidates);
    });
  }).catch(()=>{ showToast(t('toast_generic_error') || 'Harita yüklenemedi.'); });
}

function fetchProfilesFor(uids){
  return Promise.all(uids.map(uid=>
    fbDb.ref('users/' + uid).once('value').then(s=> ({ uid, data: s.val() || {} }))
  )).then(results=>{
    const map = {};
    results.forEach(r=>{ map[r.uid] = r.data; });
    return map;
  });
}

/* ============================================================
   SnapAvatarMarker — sabit boyutlu (50×92px), zoom'dan bağımsız
   ============================================================ */
class SnapAvatarMarker {
  constructor(uid, candidate, isMe){
    this.uid = uid;
    this.candidate = candidate; // {loc, profile, dist}
    this.isMe = !!isMe;
    this.el = this._buildEl();
    this.marker = new mapboxgl.Marker({ element: this.el, anchor: 'bottom' })
      .setLngLat([candidate.loc.lng, candidate.loc.lat]);
  }
  _genderColor(){
    const g = (this.candidate.profile || {}).gender;
    if(g === 'female') return '#ec4899';
    if(g === 'male') return '#3b82f6';
    return '#8b5cf6';
  }
  _buildEl(){
    const el = document.createElement('div');
    el.className = 'snapAvatarMarker' + (this.isMe ? ' is-me' : '');
    const profile = this.candidate.profile || {};
    const name = escapeHtml(profile.displayName || profile.username || '@kullanici');
    const photo = profile.photo || ('https://i.pravatar.cc/100?u=' + this.uid);
    const when = formatPostAge(this.candidate.loc.updatedAt);
    const color = this._genderColor();
    const heading = this.candidate.loc.trackMode === 'car' ? (this.candidate.loc.heading || 0) : null;
    el.innerHTML = `
      <div class="snapMarkerName">${name}</div>
      <div class="snapMarkerRing" style="--ring-color:${color}">
        ${heading !== null ? `<div class="snapMarkerHeadingArrow" style="transform:translateX(-50%) rotate(${heading}deg)"></div>` : ''}
        <img src="${photo}" onerror="this.src='https://i.pravatar.cc/100?u=${this.uid}'">
      </div>
      <div class="snapMarkerShadow"></div>
      <div class="snapMarkerTime">${when}</div>
    `;
    if(!this.isMe){
      el.addEventListener('click', ()=> openMatchProfilePreview(this.uid, this.candidate));
    }
    return el;
  }
  addTo(map){ this.marker.addTo(map); return this; }
  remove(){ try{ this.marker.remove(); }catch(e){} }
  updatePosition(lng, lat){ this.marker.setLngLat([lng, lat]); }
}

/* Aynı yerdeki (ör. aynı bina/mekan) kişileri tek bir "yığın" işaretçisinde
   birleştirir, böylece üst üste binip birbirini gizlemezler. Gerçek dünya
   mesafesi yerine EKRANDAKİ PİKSEL mesafesine göre gruplama yapılır —
   böylece haritanın o anki yakınlaştırma seviyesi ne olursa olsun (uzaktan
   bakarken üst üste binenler de, yakınlaşınca ayrılanlar da) doğru şekilde
   davranır. Zoom değiştikçe (bkz. 'zoomend' dinleyicisi) yeniden hesaplanır. */
const CLUSTER_PIXEL_THRESHOLD = 55; // ekranda bu kadar piksel veya daha yakınsa aynı yığında say
function clusterCandidatesByPixelDistance(candidates){
  if(!matchMap) return candidates.map(c=> [c]);
  const projected = candidates.map(c=> ({ c, pt: matchMap.project([c.loc.lng, c.loc.lat]) }));
  const used = new Array(projected.length).fill(false);
  const clusters = [];
  for(let i = 0; i < projected.length; i++){
    if(used[i]) continue;
    const group = [projected[i].c];
    used[i] = true;
    for(let j = i + 1; j < projected.length; j++){
      if(used[j]) continue;
      const dx = projected[i].pt.x - projected[j].pt.x;
      const dy = projected[i].pt.y - projected[j].pt.y;
      const distPx = Math.sqrt(dx * dx + dy * dy);
      if(distPx <= CLUSTER_PIXEL_THRESHOLD){ group.push(projected[j].c); used[j] = true; }
    }
    clusters.push(group);
  }
  return clusters;
}

function renderAllMatchMarkers(candidates){
  if(!matchMap) return;
  // Eskileri temizle
  Object.values(matchMapMarkers).forEach(m=> m.remove());
  matchMapMarkers = {};

  // Kendimi de arkadaşlarla AYNI kümeleme/dağıtma hesabına dahil ediyoruz —
  // yoksa bir arkadaşımla tam aynı pikselde çakışırsam kendi işaretçim
  // onunkinin arkasında tamamen gizlenip kayboluyordu.
  const allEntries = [];
  if(matchMapMyLoc && fbAuth.currentUser){
    allEntries.push({
      uid: fbAuth.currentUser.uid, isMe: true,
      loc: { lng: matchMapMyLoc.lng, lat: matchMapMyLoc.lat, updatedAt: Date.now() },
      profile: { username: savedUsername || t('match_you') || 'Sen', photo: savedProfilePhoto }
    });
  }
  candidates.forEach(c=> allEntries.push(Object.assign({ isMe: false }, c)));

  // Ekranda üst üste binenler:
  // - Yakın (sokak/şehir) zoom'da: her biri isim/foto/zamanıyla YAN YANA
  //   bir sırada, kimin kim olduğu okunabilir şekilde (mevcut davranış).
  // - Çok uzak (küre/dünya) zoom'da: Snapchat'teki gibi sıkışık, isimsiz
  //   bir "kalabalık" grubu olarak — tek tek yayılıp dünyanın öbür ucuna
  //   taşmasınlar diye.
  const isGlobeZoom = matchMap.getZoom() < 4;
  const clusters = clusterCandidatesByPixelDistance(allEntries);
  clusters.forEach((group, idx)=>{
    if(group.length === 1){
      const c = group[0];
      matchMapMarkers[c.isMe ? '__me__' : c.uid] = new SnapAvatarMarker(c.uid, c, c.isMe).addTo(matchMap);
      return;
    }
    if(isGlobeZoom){
      matchMapMarkers['__cluster_' + idx + '__'] = new SnapClusterMarker(group).addTo(matchMap);
      return;
    }
    const centroidLng = group.reduce((s,c)=> s + c.loc.lng, 0) / group.length;
    const centroidLat = group.reduce((s,c)=> s + c.loc.lat, 0) / group.length;
    const positions = computeMatchRowPositions([centroidLng, centroidLat], group.length);
    group.forEach((c, i)=>{
      const pos = positions[i];
      const spreadCandidate = Object.assign({}, c, { loc: Object.assign({}, c.loc, { lng: pos.lng, lat: pos.lat }) });
      matchMapMarkers[c.isMe ? '__me__' : c.uid] = new SnapAvatarMarker(c.uid, spreadCandidate, c.isMe).addTo(matchMap);
    });
  });
}

/* Aynı noktadaki N kişiyi, isim etiketleri birbirine çarpmayacak kadar
   aralıkla, YATAY BİR SIRA halinde (soldan sağa) dizer. Her kişi kendi
   ismi/fotoğrafı/zamanıyla, tekli işaretçilerle birebir aynı görünümde kalır. */
function computeMatchRowPositions(centroidLngLat, count){
  if(count <= 1) return [{ lng: centroidLngLat[0], lat: centroidLngLat[1] }];
  const centerPt = matchMap.project(centroidLngLat);
  const spacing = 58; // px — isim etiketleri çakışmasın diye avatar genişliğinden biraz fazla
  const totalWidth = (count - 1) * spacing;
  const startX = centerPt.x - totalWidth / 2;
  const positions = [];
  for(let i = 0; i < count; i++){
    const x = startX + i * spacing;
    const lngLat = matchMap.unproject([x, centerPt.y]);
    positions.push({ lng: lngLat.lng, lat: lngLat.lat });
  }
  return positions;
}

/* Aynı noktadaki N kişiyi, o noktanın merkezi etrafında küçük bir daire
   üzerine eşit aralıklarla yerleştirir (ekran pikseli cinsinden), böylece
   hiçbiri birbirinin üstüne binmeden yan yana görünürler. */
function computeMatchSpreadPositions(centroidLngLat, count){
  if(count <= 1) return [{ lng: centroidLngLat[0], lat: centroidLngLat[1] }];
  const centerPt = matchMap.project(centroidLngLat);
  const radius = 24 + count * 3; // kişi sayısı arttıkça daireyi biraz büyüt
  const positions = [];
  for(let i = 0; i < count; i++){
    const angle = (2 * Math.PI * i) / count - Math.PI / 2; // saat 12 yönünden başla
    const x = centerPt.x + radius * Math.cos(angle);
    const y = centerPt.y + radius * Math.sin(angle);
    const lngLat = matchMap.unproject([x, y]);
    positions.push({ lng: lngLat.lng, lat: lngLat.lat });
  }
  return positions;
}

/* ============================================================
   SnapClusterMarker — aynı konumda (≈40m içinde) birden fazla kişi varsa
   üst üste binen avatarları + "+N" rozetiyle tek bir yığın olarak gösterir.
   Tıklanınca içindekileri listeleyen bir alt sayfa açılır.
   ============================================================ */
class SnapClusterMarker {
  constructor(group){
    this.group = group;
    const lat = group.reduce((s,c)=> s + c.loc.lat, 0) / group.length;
    const lng = group.reduce((s,c)=> s + c.loc.lng, 0) / group.length;
    this.el = this._buildEl();
    this.marker = new mapboxgl.Marker({ element: this.el, anchor: 'bottom' }).setLngLat([lng, lat]);
  }
  _buildEl(){
    const el = document.createElement('div');
    el.className = 'snapClusterMarker';
    const shown = this.group.slice(0, 3);
    const extra = this.group.length - shown.length;
    const stackHtml = shown.map((c, i)=>{
      const photo = (c.profile || {}).photo || ('https://i.pravatar.cc/100?u=' + c.uid);
      const marginStyle = i === 0 ? '' : 'margin-left:-14px;';
      return `<img class="snapClusterAvatar" style="z-index:${shown.length - i};${marginStyle}" src="${photo}" onerror="this.src='https://i.pravatar.cc/100?u=${c.uid}'">`;
    }).join('');
    el.innerHTML = `
      <div class="snapClusterStack">${stackHtml}${extra > 0 ? `<div class="snapClusterExtra">+${extra}</div>` : ''}</div>
    `;
    el.addEventListener('click', ()=> openMatchClusterList(this.group));
    return el;
  }
  addTo(map){ this.marker.addTo(map); return this; }
  remove(){ try{ this.marker.remove(); }catch(e){} }
}

/* Yığındaki kişileri listeleyen alt sayfa — bir satıra dokununca o kişinin
   normal profil önizlemesi açılır (rozet kuralları orada da geçerli). */
function openMatchClusterList(group){
  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchClusterOverlay';
  overlay.style.zIndex = 10150; // profil önizlemesinin altında, harita ekranının üstünde
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchClusterList(); };
  document.body.classList.add('follow-list-open');

  const rows = group.map(c=>{
    const profile = c.profile || {};
    const name = escapeHtml(profile.displayName || profile.username || '@kullanici');
    const photo = profile.photo || ('https://i.pravatar.cc/100?u=' + c.uid);
    const when = escapeHtml(formatPostAge(c.loc.updatedAt));
    return `<div class="matchClusterRow" onclick="closeMatchClusterList();openMatchProfilePreview('${c.uid}')">
      <img src="${photo}" onerror="this.src='https://i.pravatar.cc/100?u=${c.uid}'">
      <div><div style="font-size:13.5px;font-weight:600;color:var(--text);">${name}</div>
        <div style="font-size:11px;color:var(--muted);">${when}</div></div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="followListSheet">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);">
        <h3 style="flex:1;">📍 ${group.length} ${escapeHtml(t('match_people_here'))}</h3>
        <button class="followListClose" onclick="closeMatchClusterList()">✕</button>
      </div>
      <div class="followListBody" style="padding:4px 0;">${rows}</div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeMatchClusterList(){
  const ov = document.getElementById('matchClusterOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}

/* ============================================================
   PROFİL ÖNİZLEME (alt sayfa) — openMatchProfilePreview()
   Rozet kuralı: savedVerifiedTier gold/purple değilse gönderi
   önizlemeleri gösterilmez ve "Mesaj Yaz" kilitlenir.
   ============================================================ */
function openMatchProfilePreview(uid, candidateArg){
  matchMapSelectedUid = uid;
  const candidate = candidateArg || matchMapLastCandidates.find(c=>c.uid === uid);
  if(!candidate) return;
  const profile = candidate.profile || {};
  const hasAccess = savedVerifiedTier === 'gold' || savedVerifiedTier === 'purple';
  const distText = candidate.dist < 1 ? t('match_m_away').replace('{n}', Math.round(candidate.dist*1000)) : t('match_km_away').replace('{n}', candidate.dist.toFixed(1));
  const smallAvatar = profile.photo || ('https://i.pravatar.cc/120?u=' + uid);

  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchProfileOverlay';
  overlay.style.zIndex = 10200; // harita overlay'inin üstünde dursun
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchProfilePreview(); };
  document.body.classList.add('follow-list-open');

  overlay.innerHTML = `
    <div class="followListSheet" style="max-height:88vh;">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);justify-content:flex-end;border-bottom:none;">
        <button class="matchMapIconBtn" style="background:var(--surface-2);border:1px solid var(--line);color:var(--text);width:34px;height:34px;" onclick="closeMatchProfilePreview()" title="${escapeHtml(t('match_back'))}">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="followListBody" style="padding:0 20px 20px;">
        <div style="display:flex;align-items:center;gap:14px;">
          <img src="${smallAvatar}" onerror="this.src='https://i.pravatar.cc/120?u=${uid}'" style="width:60px;height:60px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--glass-border);">
          <div>
            <div style="font-size:17px;font-weight:800;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(profile.displayName || profile.username || '@kullanici')} ${typeof verifiedBadgeHtml==='function' ? verifiedBadgeHtml(profile.verifiedTier, 15) : ''}</div>
            <div style="font-size:12.5px;color:var(--accent);margin-top:3px;">📍 ${escapeHtml(distText)} · ${escapeHtml(formatPostAge(candidate.loc.updatedAt))}</div>
          </div>
        </div>
        ${profile.bio ? `<div style="font-size:13px;color:var(--text);margin:14px 0 0;line-height:1.5;">${escapeHtml(profile.bio)}</div>` : ''}

        <div class="matchLockOverlayBox" id="matchProfilePostsWrap" style="margin-top:16px;border-radius:16px;overflow:${hasAccess ? 'hidden' : 'visible'};min-height:${hasAccess ? 90 : 230}px;background:var(--surface-2);">
          <div style="padding:24px 0;text-align:center;color:var(--muted);font-size:12px;">${escapeHtml(t('toast_loading_generic') || 'Yükleniyor...')}</div>
          ${hasAccess ? '' : `
            <div class="matchLockBadge">
              <div style="font-size:30px;">🔒</div>
              <div style="color:#fff;font-size:12.5px;max-width:240px;line-height:1.5;">${escapeHtml(t('match_upgrade_needed'))}</div>
              <button class="btn btn-primary" style="padding:9px 20px;font-size:12.5px;" onclick="closeMatchProfilePreview();openMatchVerifiedBadgeInfo('${uid}');">${escapeHtml(t('match_upgrade_btn'))}</button>
            </div>`}
        </div>

        <div style="display:flex;gap:10px;margin-top:18px;">
          <button class="btn" style="flex:1;background:var(--gradient-vivid);color:#fff;border:none;" id="matchFollowBtn" onclick="matchFollowUser('${uid}')">${escapeHtml(t('match_follow_btn'))}</button>
          <button class="btn ${hasAccess ? '' : 'btn-ghost'}" style="flex:1;${hasAccess ? 'background:var(--surface-2);color:var(--text);border:1px solid var(--line);' : ''}" onclick="${hasAccess ? `matchMessageUser('${uid}')` : `closeMatchProfilePreview();openMatchVerifiedBadgeInfo('${uid}');`}">
            ${hasAccess ? '💬 ' + escapeHtml(t('match_message_btn')) : '🔒 ' + escapeHtml(t('match_message_btn'))}
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  refreshMatchFollowButtonState(uid);
  loadMatchProfilePosts(uid, hasAccess);
}

/* Kullanıcının paylaştığı son gönderi/anı fotoğraflarını çeker ve önizler.
   Rozet kuralı: Plus/Premium değilse bulanıklaştırılıp kilit rozeti kalır
   (fotoğraflar arka planda yine de bulanık olarak yükleniyor, DOM'dan
   çalınamaz diye değil — sadece görsel amaçlı; asıl erişim kontrolü
   sunucu/Storage kurallarında sağlanmalı). */
/* Uygulamanın kendi closeVerifiedBadgeInfo() fonksiyonu her zaman Ayarlar
   paneline dönecek şekilde sabitlenmiş. Haritadan geldiğimizde bunun yerine
   profil kartına geri dönmesi için kapatma fonksiyonunu GEÇİCİ olarak
   değiştirip, iş bitince eski haline geri koyuyoruz. */
function openMatchVerifiedBadgeInfo(uid){
  if(typeof openVerifiedBadgeInfo !== 'function') return;
  const originalClose = window.closeVerifiedBadgeInfo;
  window.closeVerifiedBadgeInfo = function(){
    const ov = document.getElementById('verifiedBadgeOverlay');
    if(ov) ov.remove();
    document.body.classList.remove('follow-list-open');
    window.closeVerifiedBadgeInfo = originalClose; // uygulamanın normal davranışını geri yükle
    openMatchProfilePreview(uid);
  };
  openVerifiedBadgeInfo();
}

function loadMatchProfilePosts(uid, hasAccess){
  const wrap = document.getElementById('matchProfilePostsWrap');
  if(!wrap) return;
  fbDb.ref('posts').orderByChild('uid').equalTo(uid).limitToLast(6).once('value').then(snap=>{
    const data = snap.val() || {};
    const ids = Object.keys(data).sort((a,b)=> (data[b].ts||0) - (data[a].ts||0)).slice(0, 3);
    const lockBadge = wrap.querySelector('.matchLockBadge');
    if(!ids.length){
      wrap.innerHTML = `<div style="padding:24px 0;text-align:center;color:var(--muted);font-size:12px;">Henüz gönderi yok.</div>`;
      if(lockBadge) wrap.appendChild(lockBadge);
      return;
    }
    const thumbsHtml = ids.map(id=>{
      const p = data[id];
      const isVid = p.mediaType === 'video';
      const rawMedia = (Array.isArray(p.media) && p.media[0]) || p.photo || '';
      const thumb = isVid ? (p.coverImage || '') : rawMedia;
      return `<div style="aspect-ratio:1/1;background:var(--surface);${thumb ? `background-image:url('${thumb}');background-size:cover;background-position:center;` : ''}"></div>`;
    }).join('');
    wrap.innerHTML = `<div class="${hasAccess ? '' : 'matchLockedBlur'}" style="display:grid;grid-template-columns:repeat(${ids.length},1fr);gap:2px;">${thumbsHtml}</div>`;
    if(lockBadge) wrap.appendChild(lockBadge);
  }).catch(()=>{
    wrap.innerHTML = `<div style="padding:24px 0;text-align:center;color:var(--muted);font-size:12px;">${escapeHtml(t('toast_generic_error') || 'Yüklenemedi.')}</div>`;
  });
}
function closeMatchProfilePreview(){
  const ov = document.getElementById('matchProfileOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}

function refreshMatchFollowButtonState(uid){
  if(!fbAuth.currentUser) return;
  fbDb.ref('follows/' + fbAuth.currentUser.uid + '/' + uid).once('value').then(snap=>{
    const btn = document.getElementById('matchFollowBtn');
    if(!btn) return;
    btn.textContent = snap.exists() ? t('match_following_btn') : t('match_follow_btn');
  });
}

/* ============================================================
   TAKİP ET / MESAJ YAZ
   ============================================================ */
function matchFollowUser(uid){
  if(!fbAuth.currentUser) return;
  const myUid = fbAuth.currentUser.uid;
  const followRef = fbDb.ref('follows/' + myUid + '/' + uid);
  const followerRef = fbDb.ref('followers/' + uid + '/' + myUid);
  followRef.once('value').then(snap=>{
    if(snap.exists()){
      Promise.all([followRef.remove(), followerRef.remove()]).then(()=>{
        showToast(t('toast_unfollowed'));
        refreshMatchFollowButtonState(uid);
      });
    } else {
      Promise.all([followRef.set(true), followerRef.set(true)]).then(()=>{
        showToast(t('toast_following_check'));
        refreshMatchFollowButtonState(uid);
        if(typeof sendFollowNotification === 'function') sendFollowNotification(uid);
      });
    }
  });
}

/* Haritadan mesaj gönderme: karşılıklı takipse doğrudan sohbete gir;
   değilse (ve karşı taraf mesaj onayını kapatmadıysa) "onay bekliyor"
   durumunda bir sohbet isteği oluşturur. */
function matchMessageUser(uid){
  if(!fbAuth.currentUser) return;
  const myUid = fbAuth.currentUser.uid;
  Promise.all([
    fbDb.ref('follows/' + myUid + '/' + uid).once('value'),
    fbDb.ref('followers/' + myUid + '/' + uid).once('value'),
    fbDb.ref('users/' + uid + '/matchMsgApprovalOn').once('value')
  ]).then(([followsSnap, followersSnap, approvalSnap])=>{
    const isMutual = followsSnap.exists() && followersSnap.exists();
    const approvalRequired = approvalSnap.val() !== false; // varsayılan: açık
    if(isMutual || !approvalRequired){
      closeMatchProfilePreview();
      closeMatchMapOverlay();
      goToMatchChatSafely(uid);
      return;
    }
    sendMatchMessageRequest(uid);
  });
}

/* Overlay'leri kapatıp hemen ardından startChatWith() çağırmak, DOM henüz
   yeni düzenine oturmadan ekran geçişiyle çakışıp "ada" kaybolup sohbet
   ekranının açılmaması gibi bir yarış durumuna (race condition) yol
   açabiliyordu. Bir sonraki "tick"e erteleyip try/catch ile sarmalıyoruz. */
function goToMatchChatSafely(uid){
  setTimeout(()=>{
    try{
      // startChatWith()/openChatThread() sadece sohbet ekranının İÇ durumunu
      // (hangi mesajlaşma açık) ayarlıyor — dış "Mesajlar" ana ekranının
      // AKTİF olduğunu varsayıyor. Haritadan geldiğimizde o ekran hiç
      // aktive edilmediği için sohbet görünmez bir konteynerin içinde
      // açılıp kullanıcı akış/ana ekranda kalıyordu. Önce Mesajlar
      // ekranını gerçekten aktive edip SONRA sohbeti açıyoruz.
      if(typeof goNav === 'function') goNav('messages', null, true);
      startChatWith(uid);
    }catch(e){
      showToast(t('toast_generic_error') || 'Sohbet açılamadı, tekrar dener misin?');
    }
  }, 80);
}

function sendMatchMessageRequest(uid){
  const myUid = fbAuth.currentUser.uid;
  const chatId = makeChatId(myUid, uid);
  const ts = Date.now();
  ensureChatMeta(chatId, uid).then(()=>{
    return fbDb.ref('chatMeta/' + chatId).update({
      pendingApprovalFor: uid,
      pendingApprovalFrom: myUid,
      lastMsg: t('match_msg_pending_sent'),
      lastTs: ts,
      lastSenderUid: myUid,
      ['unreadFor/' + uid]: true
    });
  }).then(()=>{
    return fbDb.ref('chats/' + chatId + '/messages').push().set({ from: myUid, text: '👋', ts, matchMapRequest: true });
  }).then(()=>{
    fbDb.ref('notifications/' + uid).push({
      text: '<b>' + escapeHtml(savedUsername || '@kullanici') + '</b> ' + t('match_msg_approval_prompt'),
      photo: savedProfilePhoto || '', targetUid: myUid, ts, type: 'matchMsgRequest', chatId
    });
    showToast(t('match_msg_pending_sent'));
    closeMatchProfilePreview();
    closeMatchMapOverlay();
    goToMatchChatSafely(uid);
  }).catch(()=> showToast(t('toast_generic_error') || 'Mesaj gönderilemedi.'));
}

/* index.html'deki sohbet onay bandosu bu iki fonksiyonu çağırıyor
   (openChatThread içindeki approvalBanner) — burada tanımlanıyorlar. */
function approveMatchMsgRequest(chatId){
  if(!fbAuth.currentUser) return;
  fbDb.ref('chatMeta/' + chatId).update({ pendingApprovalFor: null, pendingApprovalFrom: null }).then(()=>{
    showToast(t('match_msg_approved_toast'));
    const banner = document.getElementById('chatApprovalBanner');
    if(banner) banner.style.display = 'none';
  }).catch(()=> showToast(t('toast_generic_error') || 'İşlem başarısız.'));
}
function declineMatchMsgRequest(chatId, peerUid){
  if(!confirm(t('match_msg_decline_confirm'))) return;
  const myUid = fbAuth.currentUser.uid;
  Promise.all([
    fbDb.ref('chats/' + chatId).remove(),
    fbDb.ref('chatMeta/' + chatId).remove(),
    fbDb.ref('blocks/' + myUid + '/' + peerUid).set(true),
    fbDb.ref('blockedBy/' + peerUid + '/' + myUid).set(true),
    fbDb.ref('follows/' + myUid + '/' + peerUid).remove(),
    fbDb.ref('followers/' + peerUid + '/' + myUid).remove(),
    fbDb.ref('follows/' + peerUid + '/' + myUid).remove(),
    fbDb.ref('followers/' + myUid + '/' + peerUid).remove()
  ]).then(()=>{
    showToast(t('match_msg_declined_toast'));
    if(typeof loadMyBlockList === 'function') loadMyBlockList();
    if(typeof goNav === 'function'){
      const feedBtn = document.getElementById('navFeed');
      if(feedBtn) goNav('feed', feedBtn);
    }
  }).catch(()=> showToast(t('toast_generic_error') || 'İşlem başarısız.'));
}

/* ============================================================
   AYARLAR PANELİ — Hayalet Modu / Görünürlük / Takip Modu /
   Mesaj Onayı / Paylaşımı Tamamen Kapat
   ============================================================ */
function openMatchSettings(){
  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchSettingsOverlay';
  overlay.style.zIndex = 10200;
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchSettings(); };
  document.body.classList.add('follow-list-open');

  const s = matchMapMySettings;
  // Görsel referansla birebir sıralama: Herkese Açık → Sadece Takipleştiklerim → Arkadaşlarım Hariç
  const visOptions = [
    { key:'public', title:t('match_vis_public'), desc:t('match_vis_public_desc'), sub:false },
    { key:'mutual', title:t('match_vis_mutual'), desc:t('match_vis_mutual_desc'), sub:false },
    { key:'except', title:t('match_vis_except'), desc:t('match_vis_except_desc'), sub:true }
  ];
  const trackOptions = [
    { key:'normal', title:t('match_track_normal'), desc:t('match_track_normal_desc') },
    { key:'battery', title:t('match_track_battery'), desc:t('match_track_battery_desc') },
    { key:'car', title:t('match_track_car'), desc:t('match_track_car_desc') }
  ];

  overlay.innerHTML = `
    <div class="followListSheet" style="max-height:88vh;">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);gap:12px;">
        <button class="matchMapIconBtn" style="background:var(--surface-2);border:1px solid var(--line);color:var(--text);width:34px;height:34px;flex-shrink:0;" onclick="closeMatchSettings()" title="${escapeHtml(t('match_back'))}">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <h3 style="flex:1;">${escapeHtml(t('match_settings_title'))}</h3>
        <div style="width:34px;flex-shrink:0;"></div>
      </div>
      <div class="followListBody" style="padding:16px 16px 4px;">

        <div class="matchSettingsCard">
          <div>
            <div class="lbl">👻 ${escapeHtml(t('match_ghost_mode'))}</div>
            <div class="desc">${escapeHtml(t('match_ghost_mode_desc'))}</div>
          </div>
          <div class="matchSwitch ${s.ghostMode ? 'on' : ''}" id="matchGhostSwitch" onclick="toggleMatchGhostMode()"><div class="knob"></div></div>
        </div>

        <div class="matchSettingsCard">
          <div>
            <div class="lbl">✅ ${escapeHtml(t('match_msg_approval'))}</div>
            <div class="desc">${escapeHtml(t('match_msg_approval_desc'))}</div>
          </div>
          <div class="matchSwitch ${s.msgApprovalOn ? 'on' : ''}" id="matchApprovalSwitch" onclick="toggleMatchMsgApproval()"><div class="knob"></div></div>
        </div>

        <div style="padding:18px 4px 8px;font-size:14.5px;font-weight:700;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(t('match_visibility_title'))}</div>
        <div class="matchVisGroupCard" id="matchVisOptionsWrap">
          ${visOptions.map(o=>`
            <div class="matchVisOption ${s.visibility===o.key?'selected':''}" data-vis="${o.key}" onclick="setMatchVisibility('${o.key}')">
              <div style="flex:1;"><div class="lbl" style="font-size:14px;font-weight:700;">${escapeHtml(o.title)}</div><div class="desc">${escapeHtml(o.desc)}</div></div>
              <div class="dot"></div>
              ${o.sub ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--muted)" stroke-width="2.4" style="margin-left:6px;"><path d="M9 18l6-6-6-6"/></svg>` : ''}
            </div>`).join('')}
        </div>

        <div style="padding:22px 4px 8px;font-size:14.5px;font-weight:700;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(t('match_tracking_mode_title'))}</div>
        <div class="matchVisGroupCard" id="matchTrackOptionsWrap">
          ${trackOptions.map(o=>`
            <div class="matchVisOption" data-track="${o.key}" onclick="setMatchTrackMode('${o.key}')">
              <div style="flex:1;"><div class="lbl" style="font-size:14px;font-weight:700;">${escapeHtml(o.title)}</div><div class="desc">${escapeHtml(o.desc)}</div></div>
              <div class="dot ${s.trackMode===o.key?'selected-dot':''}"></div>
            </div>`).join('')}
        </div>

        <div style="padding:22px 4px 28px;">
          <button class="matchStopSharingBtn" onclick="stopMatchLocationSharingCompletely()">${escapeHtml(t('match_stop_sharing'))}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeMatchSettings(){
  const ov = document.getElementById('matchSettingsOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}

/* "Arkadaşlarım, Şu Kişiler Hariç..." satırına dokununca açılan ayrı
   alt ekran — görsel referanstaki ">" oku bu sayfayı işaret ediyor. */
function openMatchExcludeSubScreen(){
  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchExcludeSubOverlay';
  overlay.style.zIndex = 10250;
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchExcludeSubScreen(); };
  document.body.classList.add('follow-list-open');
  overlay.innerHTML = `
    <div class="followListSheet" style="max-height:88vh;">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);">
        <button class="matchMapIconBtn" style="background:var(--surface-2);border:1px solid var(--line);color:var(--text);width:34px;height:34px;" onclick="closeMatchExcludeSubScreen()">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <h3 style="flex:1;">${escapeHtml(t('match_vis_except'))}</h3>
        <div style="width:34px;flex-shrink:0;"></div>
      </div>
      <div class="followListBody" style="padding:14px 18px;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">${escapeHtml(t('match_exclude_hint'))}</div>
        <div id="matchExcludeChips" style="display:flex;flex-wrap:wrap;gap:8px;">${escapeHtml(t('toast_loading_generic') || 'Yükleniyor...')}</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  loadMatchPeoplePicker('except');
}
function closeMatchExcludeSubScreen(){
  const ov = document.getElementById('matchExcludeSubOverlay');
  if(ov) ov.remove();
}

function toggleMatchGhostMode(){
  const myUid = fbAuth.currentUser.uid;
  matchMapMySettings.ghostMode = !matchMapMySettings.ghostMode;
  document.getElementById('matchGhostSwitch')?.classList.toggle('on', matchMapMySettings.ghostMode);
  fbDb.ref('userLocations/' + myUid + '/ghostMode').set(matchMapMySettings.ghostMode).then(()=>{
    showToast(matchMapMySettings.ghostMode ? t('match_ghost_mode_on_toast') : t('match_ghost_mode_off_toast'));
    refreshNearbyMatchUsers();
  });
}

function setMatchVisibility(key){
  const myUid = fbAuth.currentUser.uid;
  matchMapMySettings.visibility = key;
  document.querySelectorAll('.matchVisOption[data-vis]').forEach(el=> el.classList.toggle('selected', el.dataset.vis === key));
  fbDb.ref('userLocations/' + myUid + '/visibility').set(key).then(()=> refreshNearbyMatchUsers());
  if(key === 'except') openMatchExcludeSubScreen();
}

/* ---------- 'except' (hariç tutulanlar) ve 'only' (sadece şunlar) listeleri ----------
   İkisi de aynı mantıkla çalışır: karşılıklı takipleştiğin kişiler arasından
   seç; hangi Firebase alanına (excludedUids / onlyUids) yazılacağı `mode`
   parametresine göre değişir. */
function loadMatchPeoplePicker(mode){
  const myUid = fbAuth.currentUser.uid;
  const wrapId = mode === 'only' ? 'matchOnlyChips' : 'matchExcludeChips';
  const fieldName = mode === 'only' ? 'onlyUids' : 'excludedUids';
  const wrap = document.getElementById(wrapId);
  Promise.all([
    fbDb.ref('follows/' + myUid).once('value'),
    fbDb.ref('followers/' + myUid).once('value'),
    fbDb.ref('userLocations/' + myUid + '/' + fieldName).once('value')
  ]).then(([followsSnap, followersSnap, selectedSnap])=>{
    const follows = new Set(Object.keys(followsSnap.val() || {}));
    const followers = new Set(Object.keys(followersSnap.val() || {}));
    const mutualUids = [...follows].filter(u=> followers.has(u));
    const selected = selectedSnap.val() || {};
    if(!wrap) return;
    if(!mutualUids.length){ wrap.innerHTML = `<div style="font-size:12px;color:var(--muted);">—</div>`; return; }
    Promise.all(mutualUids.map(uid=> fbDb.ref('users/' + uid).once('value').then(s=>({uid, data:s.val()||{}})))).then(results=>{
      const chipLabel = mode === 'only' ? t('match_only_chip') : t('match_exclude_chip');
      const chipSelectedLabel = mode === 'only' ? t('match_only_selected_chip') : t('match_excluded_chip');
      wrap.innerHTML = results.map(r=>{
        const isSelected = !!selected[r.uid];
        const name = escapeHtml(r.data.username || r.data.displayName || '@kullanici');
        return `<div class="matchExcludeChip ${isSelected?'excluded':''}" data-uid="${r.uid}" onclick="toggleMatchPersonInList('${mode}','${r.uid}')">${isSelected ? escapeHtml(chipSelectedLabel) : escapeHtml(chipLabel)} · ${name}</div>`;
      }).join('');
    });
  });
}
function toggleMatchPersonInList(mode, uid){
  const myUid = fbAuth.currentUser.uid;
  const fieldName = mode === 'only' ? 'onlyUids' : 'excludedUids';
  const ref = fbDb.ref('userLocations/' + myUid + '/' + fieldName + '/' + uid);
  ref.once('value').then(snap=>{
    const next = !snap.exists();
    (next ? ref.set(true) : ref.remove()).then(()=>{
      loadMatchPeoplePicker(mode);
      refreshNearbyMatchUsers();
    });
  });
}

/* ---------- Hızlı Paylaş — Snapchat'teki gibi, henüz konumunu göremeyen
   karşılıklı arkadaşlarını önerir; "Paylaş"a basınca mevcut görünürlük
   moduna göre onları listeye ekler (except: hariç listesinden çıkar,
   only: sadece-listesine ekler, mutual: zaten herkese açık, bilgi verilir). */
function loadMatchQuickShareList(){
  const myUid = fbAuth.currentUser.uid;
  const listEl = document.getElementById('matchQuickShareList');
  Promise.all([
    fbDb.ref('follows/' + myUid).once('value'),
    fbDb.ref('followers/' + myUid).once('value'),
    fbDb.ref('userLocations/' + myUid).once('value')
  ]).then(([followsSnap, followersSnap, myLocSnap])=>{
    const follows = new Set(Object.keys(followsSnap.val() || {}));
    const followers = new Set(Object.keys(followersSnap.val() || {}));
    const mutualUids = [...follows].filter(u=> followers.has(u) && !isMutuallyBlocked(u));
    const myLoc = myLocSnap.val() || {};
    const vis = myLoc.visibility || 'mutual';
    const excluded = myLoc.excludedUids || {};
    const only = myLoc.onlyUids || {};
    // Zaten konumunu görebilenleri listeden çıkar
    const notYetSharing = mutualUids.filter(uid=>{
      if(vis === 'mutual') return false;               // herkes zaten görüyor
      if(vis === 'except') return !!excluded[uid];      // hariç tutulmuşsa öner
      if(vis === 'only') return !only[uid];             // henüz seçilmemişse öner
      return false;
    });
    if(!listEl) return;
    if(!notYetSharing.length){
      listEl.innerHTML = `<div style="padding:10px 18px;font-size:12px;color:var(--muted);">${escapeHtml(t('match_quick_share_empty'))}</div>`;
      return;
    }
    Promise.all(notYetSharing.slice(0,20).map(uid=> fbDb.ref('users/' + uid).once('value').then(s=>({uid, data:s.val()||{}})))).then(results=>{
      listEl.innerHTML = results.map(r=>{
        const name = escapeHtml(r.data.displayName || r.data.username || '@kullanici');
        const photo = r.data.photo || ('https://i.pravatar.cc/80?u=' + r.uid);
        return `
        <div class="followListRow" style="justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:12px;">
            <img src="${photo}" onerror="this.src='https://i.pravatar.cc/80?u=${r.uid}'">
            <div><div style="font-size:13.5px;font-weight:600;color:var(--text);">${name}</div></div>
          </div>
          <button class="btn" style="padding:7px 14px;border-radius:16px;border:1px solid var(--glass-border);background:var(--surface-2);color:var(--text);font-size:12px;font-weight:700;flex-shrink:0;"
            onclick="quickShareMatchLocationWith('${r.uid}', this)">📍 ${escapeHtml(t('match_quick_share_btn'))}</button>
        </div>`;
      }).join('');
    });
  });
}
function quickShareMatchLocationWith(uid, btnEl){
  const myUid = fbAuth.currentUser.uid;
  const vis = matchMapMySettings.visibility;
  let op;
  if(vis === 'except') op = fbDb.ref('userLocations/' + myUid + '/excludedUids/' + uid).remove();
  else if(vis === 'only') op = fbDb.ref('userLocations/' + myUid + '/onlyUids/' + uid).set(true);
  else op = Promise.resolve();
  op.then(()=>{
    if(btnEl){ btnEl.textContent = '✓'; btnEl.disabled = true; btnEl.style.opacity = '.6'; }
    showToast(t('toast_loc_added') || 'Paylaşıldı.');
    refreshNearbyMatchUsers();
    if(vis === 'except' || vis === 'only') loadMatchPeoplePicker(vis);
  });
}

function setMatchTrackMode(key){
  const myUid = fbAuth.currentUser.uid;
  matchMapMySettings.trackMode = key;
  document.querySelectorAll('.matchVisOption[data-track] .dot').forEach(dot=>{
    const optKey = dot.closest('.matchVisOption').dataset.track;
    dot.classList.toggle('selected-dot', optKey === key);
  });
  fbDb.ref('userLocations/' + myUid + '/trackMode').set(key).then(()=>{
    showToast(t('match_track_saved_toast'));
    startMatchLocationWatch(key);
  });
}

function toggleMatchMsgApproval(){
  const myUid = fbAuth.currentUser.uid;
  matchMapMySettings.msgApprovalOn = !matchMapMySettings.msgApprovalOn;
  document.getElementById('matchApprovalSwitch')?.classList.toggle('on', matchMapMySettings.msgApprovalOn);
  Promise.all([
    fbDb.ref('userLocations/' + myUid + '/msgApprovalOn').set(matchMapMySettings.msgApprovalOn),
    fbDb.ref('users/' + myUid + '/matchMsgApprovalOn').set(matchMapMySettings.msgApprovalOn)
  ]);
}

function stopMatchLocationSharingCompletely(){
  if(!confirm(t('match_stop_sharing_confirm'))) return;
  const myUid = fbAuth.currentUser.uid;
  stopMatchLocationWatch();
  fbDb.ref('userLocations/' + myUid).update({ sharing:false }).then(()=>{
    showToast(t('toast_location_sharing_off'));
    closeMatchSettings();
    closeMatchMapOverlay();
  });
}

/* ============================================================
   Android donanım geri tuşu / genel "kapat" listesine kayıt
   index.html'deki closeTopmostOverlay() fonksiyonundaki `closers`
   dizisine şu satırı eklemen yeterli (zaten eklendi, bkz. talimat):
     ['matchMapOverlay', ()=>{ if(typeof closeMatchMapOverlay==='function') closeMatchMapOverlay(); }],
   ============================================================ */

window.openMatchMap = openMatchMap;
window.closeMatchMapOverlay = closeMatchMapOverlay;
window.approveMatchMsgRequest = approveMatchMsgRequest;
window.declineMatchMsgRequest = declineMatchMsgRequest;
