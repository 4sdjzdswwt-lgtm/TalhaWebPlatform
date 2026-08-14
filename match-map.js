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
  dark: 'mapbox://styles/mapbox/dark-v11', // klasik katmanlı stil — hex renk kontrolü sadece bununla mümkün
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};
const MATCH_MAP_3D_PITCH = 0; // Harita her zaman düz kuş bakışı — 3D eğim (tilt) kullanılmıyor


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
  .matchMapSettingsBtnGlossy{background:radial-gradient(circle at 32% 28%, #8A4EB8 0%, #6B2F98 55%, #4E1F72 100%)!important;
    border:none!important;box-shadow:inset 0 2px 4px rgba(255,255,255,.35), inset 0 -4px 8px rgba(30,5,50,.55), 0 4px 12px rgba(90,34,128,.5)!important;
    position:relative;overflow:hidden;}
  .matchMapSettingsBtnGlossy::before{content:'';position:absolute;top:10%;left:18%;width:34%;height:20%;border-radius:50%;
    background:rgba(255,255,255,.55);filter:blur(2.5px);pointer-events:none;}
  .matchMapTitle{color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;text-shadow:0 1px 6px rgba(0,0,0,.5);}
  .matchMapRightBtns{display:flex;gap:8px;}
  .matchMapStyleToggleBtn{display:flex;align-items:center;gap:6px;padding:9px 16px 9px 12px;border-radius:22px;background:rgba(24,27,38,.72);
    backdrop-filter:blur(10px);border:1px solid #3A4756;color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
  .matchMapFloatingLocBtn{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 20px);right:16px;z-index:2;
    width:46px;height:46px;border-radius:50%;
    background:radial-gradient(circle at 32% 28%, #B478D6 0%, #8A4EB8 38%, #6B2F98 75%, #5A2280 100%);
    box-shadow:inset 0 2px 4px rgba(255,255,255,.55), inset 0 -5px 9px rgba(50,10,80,.5), 0 5px 14px rgba(122,66,160,.6);
    border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
  .matchMapDropBoxBtn{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 20px);left:16px;z-index:2;
    width:54px;height:54px;border-radius:50%;
    background:radial-gradient(circle at 33% 27%, #FFF2B8 0%, #FFDE66 30%, #FFC531 62%, #F5A100 100%);
    box-shadow:inset 0 3px 5px rgba(255,255,255,.85), inset 0 -7px 11px rgba(150,80,0,.4), 0 6px 16px rgba(243,167,18,.55);
    border:none;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative;overflow:hidden;}
  .matchMapDropBoxBtn::before{content:'';position:absolute;top:8%;left:16%;width:38%;height:22%;border-radius:50%;
    background:rgba(255,255,255,.75);filter:blur(3px);pointer-events:none;}
  .matchMapEmptyHint{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;color:#fff;text-align:center;
    background:rgba(5,2,15,.6);backdrop-filter:blur(6px);padding:16px 22px;border-radius:16px;font-size:13px;max-width:260px;pointer-events:none;}

  /* Kutu (anı) marker'ı — artık haritada fotoğraf yok, sadece sabit
     renkli küçük bir nokta. İçerik yalnızca dokununca (unbox) açılıyor. */
  .matchBoxDot{width:18px;height:18px;border-radius:50%;background:#F3D053;border:2.5px solid #0a0a0f;
    box-shadow:0 0 9px 2px rgba(243,208,83,.55);cursor:pointer;}

  /* Yakın zoom'daki kişi nokta marker'ı (küre'deki WebGL noktasıyla aynı
     görünüm) — Snapchat'teki gibi, aynı yerdeki kişiler hafifçe yana
     kaydırılarak (piksel offset, zoom'dan bağımsız) hiçbiri kaybolmadan
     gösteriliyor. */
  .matchDomDot{width:18px;height:18px;border-radius:50%;border:2.5px solid #0a0a0f;cursor:pointer;}
  .matchDomDot.is-me{width:20px;height:20px;background:#fff;box-shadow:0 0 9px 2px rgba(255,255,255,.6);}

  /* SnapAvatarMarker — sabit piksel boyutu, zoom'dan bağımsız */
  .snapAvatarMarker{width:50px;height:92px;display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;}
  .snapMarkerName{max-width:70px;font-size:10px;font-weight:700;color:#fff;background:rgba(5,2,15,.55);padding:2px 6px;border-radius:8px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;text-align:center;}
  .snapMarkerRing{width:46px;height:46px;border-radius:50%;padding:2.5px;background:var(--ring-color,#A872E0);
    box-shadow:0 0 10px 2px var(--ring-color,#A872E0), 0 0 0 2px rgba(0,0,0,.35);position:relative;}
  .snapMarkerRing img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;border:2px solid #0a0a0f;}
  .snapMarkerHeadingArrow{position:absolute;top:-9px;left:50%;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;
    border-bottom:9px solid var(--ring-color,#F3D053);transform-origin:50% 28px;filter:drop-shadow(0 0 3px rgba(0,0,0,.5));}
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
    // Eski DOM marker sistemi kalkınca konumu anlık güncellemek için
    // WebGL nokta katmanını (cache'lenmiş arkadaş listesiyle) tazeliyoruz.
    if(matchMap) renderAllMatchMarkers(matchMapLastCandidates || []);
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
          <button class="matchMapIconBtn matchMapSettingsBtnGlossy" onclick="openMatchSettings()" title="${escapeHtml(t('match_settings_title'))}">
            <svg viewBox="0 0 24 24" width="21" height="21">
              <defs>
                <linearGradient id="matchGearGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#fff"/>
                  <stop offset="60%" stop-color="#F0EAFF"/>
                  <stop offset="100%" stop-color="#D6C4F5"/>
                </linearGradient>
              </defs>
              <path fill="url(#matchGearGrad)" d="M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z"/>
            </svg>
          </button>
        </div>
      </div>
      <button class="matchMapFloatingLocBtn" onclick="goToMyMatchLocation()" title="${escapeHtml(t('match_my_location'))}">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L4 21l8-4 8 4z"/></svg>
      </button>
      <button class="matchMapDropBoxBtn" onclick="openMatchBoxComposer()" title="Kutu Bırak">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#18181C" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2.5" y="4" width="15" height="13" rx="2.3"/>
          <circle cx="7.3" cy="8.7" r="1.4" fill="#18181C" stroke="none"/>
          <path d="M2.5 14.5l4.2-4.2a1.5 1.5 0 012.1 0l3.9 3.9"/>
          <circle cx="18.3" cy="17.3" r="4.6" fill="#18181C" stroke="none"/>
          <path d="M18.3 19.6v-4.6M16.4 16.9l1.9-1.9 1.9 1.9" stroke="#F3D053" stroke-width="1.6"/>
        </svg>
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
    // Önce Firebase'deki (bayat olabilecek) son kayıtlı konumu geçici
    // olarak kullan ki harita hemen bir yerden açılsın, ama SONRA hemen
    // taze bir GPS okumasıyla üzerine yaz — hem ekrandaki konumu hem de
    // Firebase'deki kaydı güncelle. Eskiden harita her açıldığında sadece
    // bayat DB değerini kullanıyorduk, bu yüzden "eve" dönüyor gibi
    // görünüyordu; artık her açılışta gerçek anlık konumun alınıyor.
    // NOT: bunu "sharing" ayarına bağlı bırakmıyoruz — o alan her nedense
    // true değilse (eski/eksik veri vb.) taze konum sessizce hiç
    // alınmıyordu. Artık koşulsuz deniyoruz.
    if(typeof d.lat === 'number' && typeof d.lng === 'number') matchMapMyLoc = { lat:d.lat, lng:d.lng };
    initMatchMapInstance();
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        (pos)=>{
          matchMapMyLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          fbDb.ref('userLocations/' + myUid).update({ lat: matchMapMyLoc.lat, lng: matchMapMyLoc.lng, updatedAt: Date.now() }).catch(()=>{});
          const applyFreshLoc = ()=>{
            matchMap.jumpTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 15, pitch: 0, bearing: 0 });
            renderAllMatchMarkers(matchMapLastCandidates || []);
          };
          if(matchMap && matchMap.isStyleLoaded && matchMap.isStyleLoaded()){
            applyFreshLoc();
          } else if(matchMap){
            matchMap.once('load', applyFreshLoc); // harita henüz tam hazır değilse yüklenmesini bekle
          }
        },
        ()=>{ /* GPS alınamazsa sessizce eski (DB'deki) konumla devam */ },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    }
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
    center, zoom: 15, pitch: 0, bearing: 0, attributionControl: false,
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
    ensureMatchGlobeLayer();
    // Konum henüz gelmemişken harita varsayılan (Türkiye ortası) merkezle
    // açılmış olabilir — gerçek konum eldeyse sokak seviyesinde ortalayarak
    // asla geniş/uzak bir dünya görünümünde takılı kalmamasını sağlıyoruz.
    if(matchMapMyLoc){
      matchMap.jumpTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 15, pitch: 0, bearing: 0 });
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
  // yığınları (kimin kiminle üst üste bindiğini) yeniden hesaplamamız
  // gerekir. Işık temasını da her seferinde tazeliyoruz çünkü Standard
  // stili zoom değiştikçe rengi kendi başına biraz kayabiliyor —
  // bunu sabitleyip tutarlı tutmaya çalışıyoruz.
  matchMap.on('zoomend', ()=>{
    renderAllMatchMarkers(matchMapLastCandidates || []);
    applyMatchMap3DTheme();
  });
  // 'zoomend' elle (parmakla) yakınlaştırıp uzaklaştırmada güvenilir
  // tetikleniyor, ama flyTo() gibi ANİMASYONLU/programatik kamera
  // hareketlerinde (ör. "Konuma Git" butonu) her zaman tetiklenmeyebiliyor
  // — bu da marker'ların (DOM ↔ WebGL) yeniden çizilmeden eski/yanlış
  // konumda kalmasına yol açıyordu. 'moveend' HER kamera hareketinin
  // (flyTo, easeTo, jumpTo, elle sürükleme/zoom — hepsi) bitişinde
  // güvenilir şekilde tetiklendiği için ek bir güvence olarak kullanıyoruz.
  matchMap.on('moveend', ()=>{ renderAllMatchMarkers(matchMapLastCandidates || []); });
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

/* ============================================================
   KÜRE (GLOBE) ZOOM'UNDA HASSAS KONUMLAMA
   ------------------------------------------------------------
   Sorun: DOM tabanlı marker'lar (SnapAvatarMarker), harita küre
   projeksiyonundayken (uzak zoom) ekran konumunu WebGL render'ı kadar
   hassas hesaplayamıyor — Mapbox'ın bilinen bir sınırlaması. Uzaklaştıkça
   marker'lar gerçek noktadan gitgide sapıyor.
   Çözüm: Sadece küre zoom aralığında, kişileri DOM marker yerine
   haritanın kendi WebGL katmanına (circle layer) çiziyoruz — bu, harita
   ile TAM AYNI projeksiyon matrisini kullandığı için asla sapmıyor.
   Yakın (şehir/sokak) zoom'da bu katman boşaltılıp eski, isim/foto/zaman
   gösteren DOM marker sistemine geri dönülüyor (orada zaten sorun yoktu). */
const MATCH_GLOBE_SOURCE_ID = 'matchGlobeDotsSrc';
const MATCH_GLOBE_LAYER_ID = 'matchGlobeDotsLayer';

/* ============================================================
   WebGL-NATİF NOKTA SİSTEMİ (symbol layer + icon-offset)
   ------------------------------------------------------------
   Önceki yaklaşımlar iki ayrı sorun yaşadı:
   - DOM marker + CSS piksel offset: küre projeksiyonunda haritanın kendi
     WebGL render'ından AYRI, basitleştirilmiş bir hesapla konumlandığı
     için uzak zoom'da/hareket sırasında gerçek noktadan sapıyordu.
   - Tek "circle" katmanı: konum her zaman doğru ama üst üste binen
     kişileri ayıramıyordu (hepsi aynı pikselde birleşiyordu).
   Çözüm: "symbol" katmanı + "icon-offset". Bu, DOM/CSS'ten TAMAMEN
   BAĞIMSIZ — offset, haritanın kendi WebGL projeksiyon motorunun İÇİNDE,
   anchor noktasıyla birebir aynı sistemde hesaplanıyor. Yani küre
   eğriliğinde de, "Konuma Git" gibi animasyonlu hareketlerde de asla
   sapmıyor; ve üst üste binen kişiler sayı rozeti ("+2") yerine gerçek
   renkli noktalarının hafifçe kaydırılmasıyla ayrı ayrı okunabiliyor. */
const MATCH_DOT_IMAGE_SIZE = 40; // px, retina netliği için (ekranda daha küçük gösterilecek)
const MATCH_DOT_DISPLAY_SIZE = 20; // ekranda görünecek gerçek piksel boyutu
let matchDotImagesReady = false;

function matchDotImageIdFor(hexColor){
  return 'matchdot-' + hexColor.replace('#', '');
}
function generateMatchDotImageData(hexColor, isMe){
  const canvas = document.createElement('canvas');
  canvas.width = MATCH_DOT_IMAGE_SIZE; canvas.height = MATCH_DOT_IMAGE_SIZE;
  const ctx = canvas.getContext('2d');
  const cx = MATCH_DOT_IMAGE_SIZE / 2, cy = MATCH_DOT_IMAGE_SIZE / 2;
  const r = MATCH_DOT_IMAGE_SIZE / 2 - 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = hexColor;
  ctx.shadowColor = hexColor;
  ctx.shadowBlur = isMe ? 10 : 8;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#0a0a0f';
  ctx.stroke();
  return ctx.getImageData(0, 0, MATCH_DOT_IMAGE_SIZE, MATCH_DOT_IMAGE_SIZE);
}
function ensureMatchDotImages(){
  if(!matchMap || matchDotImagesReady) return;
  ['#FF3B30', '#3B82F6', '#FFFFFF'].forEach(color=>{
    const id = matchDotImageIdFor(color);
    if(!matchMap.hasImage(id)) matchMap.addImage(id, generateMatchDotImageData(color, color === '#FFFFFF'));
  });
  matchDotImagesReady = true;
}

function ensureMatchGlobeLayer(){
  if(!matchMap) return;
  try{
    ensureMatchDotImages();
    if(matchMap.getSource(MATCH_GLOBE_SOURCE_ID)) return; // zaten kurulu
    matchMap.addSource(MATCH_GLOBE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    matchMap.addLayer({
      id: MATCH_GLOBE_LAYER_ID,
      type: 'symbol',
      source: MATCH_GLOBE_SOURCE_ID,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': MATCH_DOT_DISPLAY_SIZE / MATCH_DOT_IMAGE_SIZE,
        'icon-offset': ['get', 'offset'],  // [x,y] piksel — icon-size ile ölçekleniyor
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      }
    });
    matchMap.on('click', MATCH_GLOBE_LAYER_ID, (e)=>{
      const myUid = fbAuth.currentUser && fbAuth.currentUser.uid;
      const seen = new Set();
      const uids = [];
      (e.features || []).forEach(f=>{
        const uid = f.properties && f.properties.uid;
        if(uid && uid !== myUid && !seen.has(uid)){ seen.add(uid); uids.push(uid); }
      });
      if(!uids.length) return;
      if(uids.length === 1){
        openMatchProfilePreview(uids[0]);
      } else {
        const group = uids.map(uid => matchMapLastCandidates.find(c=> c.uid === uid)).filter(Boolean);
        if(group.length) openMatchClusterList(group);
      }
    });
    matchMap.on('mouseenter', MATCH_GLOBE_LAYER_ID, ()=>{ matchMap.getCanvas().style.cursor = 'pointer'; });
    matchMap.on('mouseleave', MATCH_GLOBE_LAYER_ID, ()=>{ matchMap.getCanvas().style.cursor = ''; });
  }catch(e){ /* katman zaten varsa veya stil henüz hazır değilse sessizce geç */ }
}

function setMatchGlobeLayerData(entries){
  const src = matchMap.getSource(MATCH_GLOBE_SOURCE_ID);
  if(!src) return;
  // Her kullanıcı için AYRI bir feature — kimlik hiçbir zaman kaybolmuyor.
  // Ekranda üst üste binenleri (aynı gruptaki) küçük bir piksel offset'iyle
  // ayırıyoruz — ama bu offset, DOM/CSS değil, haritanın KENDİ WebGL
  // render'ının bir parçası (icon-offset), o yüzden küre eğriliğinde veya
  // hareket sırasında asla sapmıyor.
  const groups = clusterCandidatesByPixelDistance(entries);
  const features = [];
  groups.forEach(group=>{
    const offsets = computeMatchDotIconOffsets(group.length);
    group.forEach((c, i)=>{
      const color = c.isMe ? '#FFFFFF' : matchGenderColorFor(c);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.loc.lng, c.loc.lat] },
        properties: {
          uid: c.uid,
          isMe: !!c.isMe,
          iconId: matchDotImageIdFor(color),
          offset: offsets[i]
        }
      });
    });
  });
  src.setData({ type: 'FeatureCollection', features });
}

/* Aynı grup (birbirine ekranda çok yakın) içindeki N kişiyi küçük bir
   sırada, piksel cinsinden ayırır. icon-offset "icon-size" ile ölçeklendiği
   için burada icon-size'a göre normalize edilmiş bir değer veriyoruz. */
function computeMatchDotIconOffsets(count){
  if(count <= 1) return [[0, 0]];
  const spacingPx = 13;
  const scale = MATCH_DOT_IMAGE_SIZE / MATCH_DOT_DISPLAY_SIZE; // icon-offset, icon-size ölçeğinde
  const spacing = spacingPx * scale;
  const totalWidth = (count - 1) * spacing;
  const startX = -totalWidth / 2;
  const offsets = [];
  for(let i = 0; i < count; i++) offsets.push([startX + i * spacing, 0]);
  return offsets;
}

function clearMatchGlobeLayer(){
  if(!matchMap) return;
  const src = matchMap.getSource(MATCH_GLOBE_SOURCE_ID);
  if(src) src.setData({ type: 'FeatureCollection', features: [] });
}

/* Uydu ⇄ Koyu tek buton üzerinden değişir (Snapchat'teki gibi) — buton her
   zaman GEÇİLECEK modu gösterir: koyu haritadayken "🛰️ Uydu" yazar,
   uyduyken "🌙 Koyu" yazar. */
function toggleMatchMapStyleMode(){
  matchMapStyleKey = matchMapStyleKey === 'dark' ? 'satellite' : 'dark';
  updateMatchMapStyleToggleUI();
  if(!matchMap) return;
  matchDotImagesReady = false; // setStyle() özel görselleri (dot ikonları) siler — yeniden kayıt gerekecek
  matchMap.setStyle(MATCH_MAP_STYLES[matchMapStyleKey]);
  matchMap.once('style.load', ()=>{
    applyMatchMap3DTheme();
    applyMatchMapColorPalette();
    applyMatchMapHolidayTheme();
    ensureMatchGlobeLayer(); // setStyle() önceki özel katmanları/görselleri silmiş olabilir, yeniden kur
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
  if(!matchMap) return;
  // ÖNEMLİ: doğrudan önbellekteki (bayat olabilecek) matchMapMyLoc'a uçmak
  // yerine önce TAZE bir GPS okuması alıyoruz. Eskiden önce eski konuma
  // uçup, GPS güncellemesi gelince ikinci kez "düzeltiyorduk" — bu da
  // "önce yanlış yere gidip sonra kayıyor" hissi veriyordu. Artık tek
  // seferde, doğru konuma uçuyoruz.
  const flyToLoc = (lat, lng)=>{
    matchMap.flyTo({ center: [lng, lat], zoom: 15, pitch: 0, bearing: 0 });
    matchMap.once('moveend', ()=>{ renderAllMatchMarkers(matchMapLastCandidates || []); });
  };
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        matchMapMyLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        flyToLoc(matchMapMyLoc.lat, matchMapMyLoc.lng);
        // Sadece ekranı değil, Firebase'deki kaydı da güncelle — yoksa
        // haritayı kapatıp tekrar açınca yine eski (bayat) konum gelirdi.
        if(fbAuth.currentUser){
          fbDb.ref('userLocations/' + fbAuth.currentUser.uid).update({
            lat: matchMapMyLoc.lat, lng: matchMapMyLoc.lng, updatedAt: Date.now()
          }).catch(()=>{});
        }
      },
      ()=>{ if(matchMapMyLoc) flyToLoc(matchMapMyLoc.lat, matchMapMyLoc.lng); }, // GPS alınamazsa önbellekteki son bilinen konuma uç
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );
  } else if(matchMapMyLoc){
    flyToLoc(matchMapMyLoc.lat, matchMapMyLoc.lng);
  }
}

/* ============================================================
   ÖZEL RENK PALETİ — verilen HEX kodlarıyla
   Mapbox'ın hazır "dark-v11" stilini, verilen HEX paletine göre
   katman katman yeniden renklendirir (Mapbox Studio'ya ihtiyaç
   duymadan, istemci tarafında setPaintProperty ile). Uydu modunda
   (raster gerçek görüntü) renk override edilmez, olduğu gibi kalır. */
const MATCH_MAP_PALETTE = {
  bg: '#1E2536',       // Koyu Lacivert / Gece Mavisi — ana zemin
  bgAlt: '#18181C',     // Koyu Duman Gri — binalar
  land: '#2A3B37',      // Koyu Zeytin Yeşili — orman/yeşil alan
  landLight: '#3A4F48', // Açık Zeytin Yeşili — aydınlık yeşil bölgeler (park vb.)
  water: '#0A0A0C',     // Siyah — su
  roadThin: '#3D495B',  // Gri-Mavi — ince sokak/yol hatları
  roadMain: '#3D495B',  // Gri-Mavi — ana yollar da aynı ton (istenen palette ayrı ana yol rengi yok)
  text: '#FFFFFF'       // Beyaz — metinler
};
function applyMatchMapColorPalette(){
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
        else if(key.includes('park') || key.includes('grass'))
          matchMap.setPaintProperty(layer.id, 'fill-color', MATCH_MAP_PALETTE.landLight);
        else if(key.includes('land') || key.includes('landuse') || key.includes('wood') || key.includes('vegetation'))
          matchMap.setPaintProperty(layer.id, 'fill-color', MATCH_MAP_PALETTE.land);
      } else if(layer.type === 'line'){
        if(key.includes('road') || key.includes('bridge') || key.includes('tunnel')){
          matchMap.setPaintProperty(layer.id, 'line-color', MATCH_MAP_PALETTE.roadThin);
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
  refreshNearbyMapBoxes(); // kutu sistemi — arkadaş konum sisteminden AYRI, birlikte çalışır
}

/* ============================================================
   KUTU (ANI) SİSTEMİ — SpotBox tarzı
   ------------------------------------------------------------
   Konuma fotoğraf/video anı bırakma ve yakındaki kutuları keşfetme.
   Arkadaş canlı konum sisteminden TAMAMEN AYRI, ikisi birlikte çalışır.
   Firebase şeması: mapBoxes/{boxId}
     uid, ts, lat, lng, title,
     mediaType: 'photo' | 'video', media (fotoğrafta base64, videoda Storage URL),
     visibility: 'public' | 'mutual' | 'except', excludedUids: {}
   ============================================================ */
let matchMapBoxesLastList = [];
let matchBoxMarkers = {};
let matchBoxComposerFile = null;
let matchBoxComposerType = null; // 'photo' | 'video'
let matchBoxComposerVisibility = 'public';

function loadNearbyMapBoxes(){
  if(!matchMapMyLoc || !fbAuth.currentUser) return Promise.resolve([]);
  const myUid = fbAuth.currentUser.uid;
  return Promise.all([
    fbDb.ref('mapBoxes').orderByChild('ts').limitToLast(300).once('value'),
    fbDb.ref('follows/' + myUid).once('value'),
    fbDb.ref('followers/' + myUid).once('value')
  ]).then(([boxesSnap, myFollowsSnap, myFollowersSnap])=>{
    const myFollows = new Set(Object.keys(myFollowsSnap.val() || {}));
    const myFollowers = new Set(Object.keys(myFollowersSnap.val() || {}));
    const all = boxesSnap.val() || {};
    const list = [];
    Object.keys(all).forEach(boxId=>{
      const b = all[boxId];
      if(!b || typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.media) return;
      if(b.uid !== myUid && isMutuallyBlocked(b.uid)) return;
      const isMutual = myFollows.has(b.uid) && myFollowers.has(b.uid);
      const vis = b.visibility || 'public';
      if(b.uid !== myUid){
        if(vis === 'mutual'){ if(!isMutual) return; }
        else if(vis === 'except'){ if(!isMutual) return; if((b.excludedUids || {})[myUid]) return; }
        else if(vis !== 'public'){ return; }
      }
      const dist = haversineKm(matchMapMyLoc.lat, matchMapMyLoc.lng, b.lat, b.lng);
      if(dist > 100) return;
      list.push({ boxId, box: b, dist });
    });
    list.sort((a,b)=> a.dist - b.dist);
    return list.slice(0, 60);
  });
}

function refreshNearbyMapBoxes(){
  loadNearbyMapBoxes().then(list=>{
    matchMapBoxesLastList = list;
    renderAllMatchBoxMarkers(list);
  }).catch(()=>{});
}

class MatchBoxMarker {
  constructor(item){
    this.item = item;
    this.el = this._buildEl();
    this.marker = new mapboxgl.Marker({ element: this.el, anchor: 'center' })
      .setLngLat([item.box.lng, item.box.lat]);
  }
  _buildEl(){
    // Haritada fotoğraf/başlık gösterilmiyor — sadece küçük, sabit renkli
    // bir nokta. Fotoğraf yalnızca noktaya dokunulunca (openMatchBoxPreview)
    // rozet kuralına göre açılıyor.
    const el = document.createElement('div');
    el.className = 'matchBoxDot';
    el.title = 'Kutu';
    el.addEventListener('click', ()=> openMatchBoxPreview(this.item.boxId, this.item));
    return el;
  }
  addTo(map){ this.marker.addTo(map); return this; }
  remove(){ try{ this.marker.remove(); }catch(e){} }
}

function renderAllMatchBoxMarkers(list){
  if(!matchMap) return;
  Object.values(matchBoxMarkers).forEach(m=> m.remove());
  matchBoxMarkers = {};
  list.forEach(item=>{
    matchBoxMarkers[item.boxId] = new MatchBoxMarker(item).addTo(matchMap);
  });
}

/* ---------- Kutu bırakma (composer) ---------- */
function openMatchBoxComposer(){
  if(!requireFirebase() || !fbAuth.currentUser) return;
  if(!matchMapMyLoc){ showToast(t('toast_loc_denied') || 'Önce konumunu paylaşman gerekiyor.'); return; }
  matchBoxComposerFile = null; matchBoxComposerType = null; matchBoxComposerVisibility = 'public';

  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchBoxComposerOverlay';
  overlay.style.zIndex = 10250;
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchBoxComposer(); };
  document.body.classList.add('follow-list-open');

  overlay.innerHTML = `
    <div class="followListSheet" style="max-height:88vh;">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);gap:12px;">
        <button class="matchMapIconBtn" style="background:var(--surface-2);border:1px solid var(--line);color:var(--text);width:34px;height:34px;flex-shrink:0;" onclick="closeMatchBoxComposer()">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <h3 style="flex:1;">📦 ${escapeHtml(t('match_box_composer_title'))}</h3>
        <div style="width:34px;flex-shrink:0;"></div>
      </div>
      <div class="followListBody" style="padding:16px;">
        <input type="file" id="matchBoxFileInput" accept="image/*,video/*" style="display:none;" onchange="onMatchBoxFileChosen(this)">
        <div id="matchBoxPreviewWrap" onclick="document.getElementById('matchBoxFileInput').click()"
          style="display:flex;align-items:center;gap:14px;padding:12px;border-radius:16px;background:var(--surface-2);border:1.5px dashed var(--line);cursor:pointer;">
          <div id="matchBoxThumbBox" style="width:56px;height:56px;border-radius:12px;background:var(--surface);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:22px;">📷</div>
          <div style="font-size:13px;color:var(--muted);font-weight:600;">${escapeHtml(t('match_box_choose_media'))}</div>
        </div>

        <input id="matchBoxTitleInput" type="text" maxlength="60" placeholder="${escapeHtml(t('match_box_title_placeholder'))}"
          style="width:100%;margin-top:14px;padding:12px 14px;border-radius:14px;background:var(--surface-2);border:1px solid var(--line);color:var(--text);font-size:14px;">

        <div style="padding:18px 2px 8px;font-size:13.5px;font-weight:700;color:var(--text);">${escapeHtml(t('match_box_who_sees'))}</div>
        <div class="matchVisGroupCard" id="matchBoxVisWrap">
          <div class="matchVisOption selected" data-boxvis="public" onclick="setMatchBoxVisibility('public')">
            <div style="flex:1;"><div class="lbl" style="font-size:14px;font-weight:700;">${escapeHtml(t('match_box_vis_public'))}</div><div class="desc">${escapeHtml(t('match_box_vis_public_desc'))}</div></div>
            <div class="dot"></div>
          </div>
          <div class="matchVisOption" data-boxvis="mutual" onclick="setMatchBoxVisibility('mutual')">
            <div style="flex:1;"><div class="lbl" style="font-size:14px;font-weight:700;">${escapeHtml(t('match_box_vis_mutual'))}</div><div class="desc">${escapeHtml(t('match_box_vis_mutual_desc'))}</div></div>
            <div class="dot"></div>
          </div>
          <div class="matchVisOption" data-boxvis="except" onclick="setMatchBoxVisibility('except')">
            <div style="flex:1;"><div class="lbl" style="font-size:14px;font-weight:700;">${escapeHtml(t('match_box_vis_except'))}</div><div class="desc">${escapeHtml(t('match_box_vis_except_desc'))}</div></div>
            <div class="dot"></div>
          </div>
        </div>

        <button class="btn" id="matchBoxSubmitBtn" style="width:100%;margin-top:20px;padding:15px;border-radius:16px;border:none;background:var(--gradient-vivid);color:#fff;font-weight:800;font-size:14.5px;" onclick="submitMatchBox()">📦 ${escapeHtml(t('match_box_submit'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeMatchBoxComposer(){
  const ov = document.getElementById('matchBoxComposerOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}
function setMatchBoxVisibility(key){
  matchBoxComposerVisibility = key;
  document.querySelectorAll('.matchVisOption[data-boxvis]').forEach(el=> el.classList.toggle('selected', el.dataset.boxvis === key));
}
function onMatchBoxFileChosen(input){
  const file = input.files && input.files[0];
  if(!file) return;
  matchBoxComposerFile = file;
  matchBoxComposerType = file.type.indexOf('video') === 0 ? 'video' : 'photo';
  const thumb = document.getElementById('matchBoxThumbBox');
  if(!thumb) return;
  const url = URL.createObjectURL(file);
  if(matchBoxComposerType === 'video'){
    thumb.innerHTML = `<video src="${url}" style="width:100%;height:100%;object-fit:cover;" muted playsinline></video>`;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = ()=>{
      if(probe.duration > 20) showToast('İpucu: kısa (≈15 sn) videolar daha iyi görünür.');
    };
    probe.src = url;
  } else {
    // NOT: ön kamerayla çekilen fotoğraflardaki "ayna" görüntüsü, cihazın
    // kendi kamera uygulamasından geliyor — dosya seçildikten sonra bizim
    // tarafımızda bir çevirme/yansıtma işlemi UYGULANMIYOR, yani burada
    // ekstra bir CSS/transform ekleyip görüntüyü bozmuyoruz. Sorun cihazın
    // kamerasından kaynaklanıyorsa bu adımda düzeltilemez.
    thumb.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">`;
  }
  const wrap = document.getElementById('matchBoxPreviewWrap');
  if(wrap) wrap.style.borderStyle = 'solid';
}
function submitMatchBox(){
  if(!matchBoxComposerFile){ showToast(t('match_box_need_media')); return; }
  if(!matchMapMyLoc || !fbAuth.currentUser) return;
  const titleInput = document.getElementById('matchBoxTitleInput');
  const title = titleInput ? titleInput.value.trim().slice(0, 60) : '';
  const btn = document.getElementById('matchBoxSubmitBtn');
  const resetBtn = ()=>{ if(btn){ btn.disabled = false; btn.textContent = '📦 ' + t('match_box_submit'); } };
  if(btn){ btn.disabled = true; btn.textContent = t('match_box_submitting'); }
  const myUid = fbAuth.currentUser.uid;
  const boxId = fbDb.ref('mapBoxes').push().key;
  const baseData = {
    uid: myUid, ts: Date.now(), lat: matchMapMyLoc.lat, lng: matchMapMyLoc.lng,
    title, visibility: matchBoxComposerVisibility, mediaType: matchBoxComposerType
  };
  const finish = (mediaUrl)=>{
    fbDb.ref('mapBoxes/' + boxId).set(Object.assign({}, baseData, { media: mediaUrl })).then(()=>{
      showToast(t('match_box_dropped_toast'));
      closeMatchBoxComposer();
      refreshNearbyMapBoxes();
    }).catch(()=>{
      showToast(t('toast_generic_error') || 'Kutu bırakılamadı, tekrar dener misin?');
      resetBtn();
    });
  };
  if(matchBoxComposerType === 'video'){
    if(!fbStorage){ showToast(t('toast_video_needs_storage2') || 'Video için depolama kullanılamıyor.'); resetBtn(); return; }
    const path = 'mapBoxes/' + myUid + '/' + Date.now() + '.mp4';
    fbStorage.ref().child(path).put(matchBoxComposerFile)
      .then(s=> s.ref.getDownloadURL()).then(finish)
      .catch(()=>{ showToast(t('toast_video_upload_fail') || 'Video yüklenemedi.'); resetBtn(); });
  } else {
    const reader = new FileReader();
    reader.onload = ()=>{
      (typeof compressForPost === 'function' ? compressForPost(reader.result) : Promise.resolve(reader.result)).then(finish);
    };
    reader.onerror = ()=>{ showToast(t('toast_generic_error') || 'Fotoğraf okunamadı.'); resetBtn(); };
    reader.readAsDataURL(matchBoxComposerFile);
  }
}

/* ---------- Kutuyu açma ("unbox") önizlemesi ---------- */
function openMatchBoxPreview(boxId, itemArg){
  const item = itemArg || matchMapBoxesLastList.find(i=> i.boxId === boxId);
  if(!item) return;
  const b = item.box;
  const hasAccess = savedVerifiedTier === 'gold' || savedVerifiedTier === 'purple';
  const isOwn = fbAuth.currentUser && b.uid === fbAuth.currentUser.uid;
  const distText = item.dist < 1 ? t('match_m_away').replace('{n}', Math.round(item.dist * 1000)) : t('match_km_away').replace('{n}', item.dist.toFixed(1));

  const overlay = document.createElement('div');
  overlay.className = 'followListOverlay';
  overlay.id = 'matchBoxPreviewOverlay';
  overlay.style.zIndex = 10200;
  overlay.onclick = (e)=>{ if(e.target === overlay) closeMatchBoxPreview(); };
  document.body.classList.add('follow-list-open');

  overlay.innerHTML = `
    <div class="followListSheet" style="max-height:90vh;">
      <div class="followListHead" style="position:sticky;top:0;z-index:5;background:var(--surface);flex-shrink:0;padding-top:calc(env(safe-area-inset-top,0px) + 16px);justify-content:flex-end;border-bottom:none;">
        <button class="matchMapIconBtn" style="background:var(--surface-2);border:1px solid var(--line);color:var(--text);width:34px;height:34px;" onclick="closeMatchBoxPreview()">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="followListBody" style="padding:0 20px 20px;" id="matchBoxOwnerWrap">
        <div style="display:flex;align-items:center;gap:14px;">
          <div style="width:60px;height:60px;border-radius:50%;background:var(--surface-2);flex-shrink:0;"></div>
          <div style="font-size:12.5px;color:var(--muted);">Yükleniyor...</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  fbDb.ref('users/' + b.uid).once('value').then(snap=>{
    const profile = snap.val() || {};
    const wrap = document.getElementById('matchBoxOwnerWrap');
    if(!wrap) return;
    const smallAvatar = profile.deleted ? 'default-avatar.png' : (profile.photo || 'default-avatar.png');
    const showFull = hasAccess || isOwn;
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;">
        <img src="${smallAvatar}" onerror="this.src='default-avatar.png'" style="width:60px;height:60px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--glass-border);">
        <div>
          <div style="font-size:17px;font-weight:800;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(profile.displayName || profile.username || '@kullanici')} ${typeof verifiedBadgeHtml === 'function' ? verifiedBadgeHtml(profile.verifiedTier, 15) : ''}</div>
          <div style="font-size:12.5px;color:var(--accent);margin-top:3px;">📍 ${escapeHtml(distText)} · ${escapeHtml(formatPostAge(b.ts))}</div>
        </div>
      </div>
      ${b.title ? `<div style="font-size:14px;color:var(--text);margin:14px 0 0;font-weight:600;">${escapeHtml(b.title)}</div>` : ''}

      <div class="matchLockOverlayBox" id="matchBoxMediaWrap" style="margin-top:16px;border-radius:16px;overflow:${showFull ? 'hidden' : 'visible'};min-height:${showFull ? 90 : 230}px;background:var(--surface-2);">
        ${showFull ? matchBoxMediaHtml(b) : `<div class="matchLockedBlur">${matchBoxMediaHtml(b)}</div>
          <div class="matchLockBadge">
            <div style="font-size:30px;">🔒</div>
            <div style="color:#fff;font-size:12.5px;max-width:240px;line-height:1.5;">${escapeHtml(t('match_upgrade_needed'))}</div>
            <button class="btn btn-primary" style="padding:9px 20px;font-size:12.5px;" onclick="closeMatchBoxPreview();openMatchVerifiedBadgeInfoForBox('${boxId}');">${escapeHtml(t('match_upgrade_btn'))}</button>
          </div>`}
      </div>

      ${isOwn ? `
        <button class="btn" style="width:100%;margin-top:18px;padding:14px;border-radius:16px;border:1.5px solid var(--danger);background:rgba(237,73,86,.12);color:var(--danger);font-weight:800;" onclick="deleteMatchBox('${boxId}')">🗑️ ${escapeHtml(t('match_box_delete'))}</button>
      ` : `
        <div style="display:flex;gap:10px;margin-top:18px;">
          <button class="btn" style="flex:1;background:var(--gradient-vivid);color:#fff;border:none;" onclick="matchFollowUser('${b.uid}')">${escapeHtml(t('match_follow_btn'))}</button>
          <button class="btn ${hasAccess ? '' : 'btn-ghost'}" style="flex:1;${hasAccess ? 'background:var(--surface-2);color:var(--text);border:1px solid var(--line);' : ''}" onclick="${hasAccess ? `matchMessageUser('${b.uid}')` : `closeMatchBoxPreview();openMatchVerifiedBadgeInfoForBox('${boxId}');`}">
            ${hasAccess ? '💬 ' + escapeHtml(t('match_message_btn')) : '🔒 ' + escapeHtml(t('match_message_btn'))}
          </button>
        </div>
      `}
    `;
  });
}
function matchBoxMediaHtml(b){
  if(b.mediaType === 'video'){
    return `<video src="${b.media}" controls playsinline style="width:100%;max-height:340px;display:block;background:#000;"></video>`;
  }
  return `<img src="${b.media}" style="width:100%;max-height:340px;object-fit:cover;display:block;">`;
}
function closeMatchBoxPreview(){
  const ov = document.getElementById('matchBoxPreviewOverlay');
  if(ov) ov.remove();
  document.body.classList.remove('follow-list-open');
}
function deleteMatchBox(boxId){
  if(!confirm(t('match_box_delete_confirm'))) return;
  fbDb.ref('mapBoxes/' + boxId).remove().then(()=>{
    showToast(t('match_box_deleted_toast'));
    closeMatchBoxPreview();
    refreshNearbyMapBoxes();
  }).catch(()=> showToast(t('toast_generic_error') || 'Silinemedi.'));
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
function matchGenderColorFor(candidate){
  const g = ((candidate || {}).profile || {}).gender;
  if(g === 'female') return '#FF3B30'; // kırmızı
  if(g === 'male') return '#3B82F6';   // mavi
  return '#FFFFFF'; // belirtilmemiş — beyaz
}

class SnapAvatarMarker {
  constructor(uid, candidate, isMe, pixelOffset){
    this.uid = uid;
    this.candidate = candidate; // {loc, profile, dist}
    this.isMe = !!isMe;
    this.el = this._buildEl();
    this.marker = new mapboxgl.Marker({ element: this.el, anchor: 'bottom', offset: pixelOffset || [0, 0] })
      .setLngLat([candidate.loc.lng, candidate.loc.lat]);
  }
  _genderColor(){
    return matchGenderColorFor(this.candidate);
  }
  _buildEl(){
    const el = document.createElement('div');
    el.className = 'snapAvatarMarker' + (this.isMe ? ' is-me' : '');
    const profile = this.candidate.profile || {};
    const name = escapeHtml(profile.displayName || profile.username || '@kullanici');
    const photo = profile.photo || 'default-avatar.png';
    const when = formatPostAge(this.candidate.loc.updatedAt);
    const color = this._genderColor();
    const heading = this.candidate.loc.trackMode === 'car' ? (this.candidate.loc.heading || 0) : null;
    el.innerHTML = `
      <div class="snapMarkerName">${name}</div>
      <div class="snapMarkerRing" style="--ring-color:${color}">
        ${heading !== null ? `<div class="snapMarkerHeadingArrow" style="transform:translateX(-50%) rotate(${heading}deg)"></div>` : ''}
        <img src="${photo}" onerror="this.src='default-avatar.png'">
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
  const allEntries = [];
  if(matchMapMyLoc && fbAuth.currentUser){
    allEntries.push({
      uid: fbAuth.currentUser.uid, isMe: true,
      loc: { lng: matchMapMyLoc.lng, lat: matchMapMyLoc.lat, updatedAt: Date.now() },
      profile: { username: savedUsername || t('match_you') || 'Sen', photo: savedProfilePhoto }
    });
  }
  candidates.forEach(c=> allEntries.push(Object.assign({ isMe: false }, c)));

  // Artık TEK bir sistem — hem küre hem yakın zoom'da aynı WebGL-native
  // symbol katmanı kullanılıyor (bkz. ensureMatchGlobeLayer/setMatchGlobeLayerData
  // yukarıdaki tanım). Konum hiçbir zaman sapmıyor, üst üste binenler de
  // sayı rozeti olmadan, kendi renkli noktalarının hafif kaydırılmasıyla
  // ayrı ayrı gösteriliyor.
  ensureMatchGlobeLayer();
  setMatchGlobeLayerData(allEntries);
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
      const photo = (c.profile || {}).photo || 'default-avatar.png';
      const marginStyle = i === 0 ? '' : 'margin-left:-14px;';
      return `<img class="snapClusterAvatar" style="z-index:${shown.length - i};${marginStyle}" src="${photo}" onerror="this.src='default-avatar.png'">`;
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
    const photo = profile.photo || 'default-avatar.png';
    const when = escapeHtml(formatPostAge(c.loc.updatedAt));
    return `<div class="matchClusterRow" onclick="closeMatchClusterList();openMatchProfilePreview('${c.uid}')">
      <img src="${photo}" onerror="this.src='default-avatar.png'">
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
  const smallAvatar = profile.deleted ? 'default-avatar.png' : (profile.photo || 'default-avatar.png');

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
          <img src="${smallAvatar}" onerror="this.src='default-avatar.png'" style="width:60px;height:60px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--glass-border);">
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
   ilgili karta (profil veya kutu) geri dönmesi için kapatma fonksiyonunu
   GEÇİCİ olarak değiştirip, iş bitince eski haline geri koyuyoruz. */
function openMatchVerifiedBadgeInfoGeneric(reopenFn){
  if(typeof openVerifiedBadgeInfo !== 'function') return;
  const originalClose = window.closeVerifiedBadgeInfo;
  window.closeVerifiedBadgeInfo = function(){
    const ov = document.getElementById('verifiedBadgeOverlay');
    if(ov) ov.remove();
    document.body.classList.remove('follow-list-open');
    window.closeVerifiedBadgeInfo = originalClose; // uygulamanın normal davranışını geri yükle
    reopenFn();
  };
  openVerifiedBadgeInfo();
}
function openMatchVerifiedBadgeInfo(uid){
  openMatchVerifiedBadgeInfoGeneric(()=> openMatchProfilePreview(uid));
}
function openMatchVerifiedBadgeInfoForBox(boxId){
  openMatchVerifiedBadgeInfoGeneric(()=> openMatchBoxPreview(boxId));
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
        const photo = r.data.photo || 'default-avatar.png';
        return `
        <div class="followListRow" style="justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:12px;">
            <img src="${photo}" onerror="this.src='default-avatar.png'">
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
