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
const MATCH_MAP_MAX_DISTANCE_KM = Infinity; // mesafe sınırı kaldırıldı — artık ne kadar uzak olursa olsun herkes gösteriliyor
const MATCH_MAP_MAX_RESULTS = Infinity; // sonuç sayısı sınırı kaldırıldı — artık kaç kişi olursa olsun hepsi gösteriliyor
const MATCH_MAP_STYLES = {
  dark: 'mapbox://styles/mapbox/dark-v11', // klasik katmanlı stil — hex renk kontrolü sadece bununla mümkün
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};
const MATCH_MAP_3D_PITCH = 50; // Koyu haritada sabit 3D açı — dokunarak değiştirilemez (touchPitch:false), sadece kod tarafından ayarlanır
const MATCH_MAP_DRIVING_SPEED_KMH = 20; // Bu hızın (km/sa) üzerindeyse "araba/araç içinde" kabul edilir ve marker 🚗 ikonuna döner


/* ---------- DURUM ---------- */
let matchMap = null;
let matchMapStyleKey = 'dark';
let matchMapMarkers = {};              // uid -> SnapAvatarMarker
let matchMapMyLoc = null;              // {lat,lng}
let matchMapMyHeading = null;          // kendi anlık yönümüz (derece) — varsa
let matchMapMyIsDriving = false;       // kendi anlık "araç içinde" durumumuz (hıza göre otomatik)
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
  .matchMapFloatingLocBtn{position:fixed!important;bottom:calc(env(safe-area-inset-bottom,0px) + 20px)!important;right:16px!important;top:auto!important;left:auto!important;z-index:9600!important;
    width:46px;height:46px;border-radius:50%;
    background:radial-gradient(circle at 32% 28%, #B478D6 0%, #8A4EB8 38%, #6B2F98 75%, #5A2280 100%);
    box-shadow:inset 0 2px 4px rgba(255,255,255,.55), inset 0 -5px 9px rgba(50,10,80,.5), 0 5px 14px rgba(122,66,160,.6);
    border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
  .matchMapDropBoxBtn{position:fixed!important;bottom:calc(env(safe-area-inset-bottom,0px) + 20px)!important;left:16px!important;top:auto!important;right:auto!important;z-index:9600!important;
    width:54px;height:54px;border-radius:50%;
    background:radial-gradient(circle at 33% 27%, #FFF2B8 0%, #FFDE66 30%, #FFC531 62%, #F5A100 100%);
    box-shadow:inset 0 3px 5px rgba(255,255,255,.85), inset 0 -7px 11px rgba(150,80,0,.4), 0 6px 16px rgba(243,167,18,.55);
    border:none;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;}
  .matchMapDropBoxBtn::before{content:'';position:absolute;top:8%;left:16%;width:38%;height:22%;border-radius:50%;
    background:rgba(255,255,255,.75);filter:blur(3px);pointer-events:none;}
  .matchMapEmptyHint{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;color:#fff;text-align:center;
    background:rgba(5,2,15,.6);backdrop-filter:blur(6px);padding:16px 22px;border-radius:16px;font-size:13px;max-width:260px;pointer-events:none;}

  /* Canlı hava durumu kutucuğu — üst çubuğun hemen altında, ortada */
  .matchMapWeatherPill{position:absolute;top:calc(env(safe-area-inset-top,0px) + 62px);left:50%;transform:translateX(-50%);z-index:2;
    display:flex;align-items:center;gap:7px;padding:8px 16px;border-radius:20px;background:rgba(24,27,38,.72);
    backdrop-filter:blur(10px);border:1px solid #3A4756;color:#fff;font-size:13px;font-weight:700;white-space:nowrap;
    opacity:0;transition:opacity .3s;pointer-events:none;}
  .matchMapWeatherPill.visible{opacity:1;}

  /* Kutu (anı) marker'ı — hediye kutusu ikonu, sahibinin cinsiyetine göre
     renk tonu değişiyor (hue-rotate filtresiyle). İçerik yalnızca
     dokununca (unbox) açılıyor. */
  .matchBoxDot{width:34px;height:34px;background-image:url('gift-box.png');background-size:contain;
    background-repeat:no-repeat;background-position:center;cursor:pointer;
    filter:drop-shadow(0 0 5px rgba(243,208,83,.55));}

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

/* Bir GPS okumasından (coords) Firebase'e yazılacak alanları üretir.
   Hız (speed, m/s) km/sa'ya çevrilir; eşiği aşarsa "araba içinde" kabul
   edilip isDriving:true yazılır — marker bunu görünce 🚗 ikonuna döner.
   heading da (varsa) yazılır ki yön oku her modda çalışsın, sadece
   Araba Modu'na özel olmasın (artık Normal de sürekli takip ediyor). */
function buildMatchLocUpdate(coords){
  const { latitude, longitude, heading, speed } = coords;
  const speedKmh = (typeof speed === 'number' && !isNaN(speed) && speed >= 0) ? speed * 3.6 : 0;
  const update = {
    lat: latitude, lng: longitude, updatedAt: Date.now(),
    speedKmh: Math.round(speedKmh),
    isDriving: speedKmh >= MATCH_MAP_DRIVING_SPEED_KMH
  };
  if(typeof heading === 'number' && !isNaN(heading)) update.heading = heading;
  // Kendi marker'ımızı (isMe) da aynı bilgiyle çizebilmek için yerel
  // değişkenlere de yansıtıyoruz — renderAllMatchMarkers bunu okuyor.
  matchMapMyIsDriving = update.isDriving;
  matchMapMyHeading = (typeof update.heading === 'number') ? update.heading : matchMapMyHeading;
  return update;
}

/* ---------- Konum paylaşımını aç ve haritayı başlat ---------- */
function enableMatchLocationSharing(){
  if(!navigator.geolocation){ showToast(t('toast_no_geo')); return; }
  const myUid = fbAuth.currentUser.uid;
  showToast(t('toast_loc_loading'));
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      const { latitude, longitude } = pos.coords;
      matchMapMyLoc = { lat: latitude, lng: longitude };
      matchMapMySettings.sharing = true;
      fbDb.ref('userLocations/' + myUid).update(Object.assign(buildMatchLocUpdate(pos.coords), {
        sharing: true, ghostMode: false,
        visibility: matchMapMySettings.visibility || 'public',
        trackMode: matchMapMySettings.trackMode || 'normal'
      })).then(()=>{
        startMatchLocationWatch(matchMapMySettings.trackMode || 'normal');
        openMatchMapOverlay();
      }).catch(()=> showToast(t('toast_generic_error') || 'Konum kaydedilemedi.'));
    },
    ()=>{ showToast(t('toast_loc_denied')); },
    { enableHighAccuracy:true, timeout:12000, maximumAge:60000 }
  );
}

/* ---------- Konum takibi: Normal ve Araba artık AYNI şekilde çalışır —
   ikisi de sürekli/anlık takip yapar (watchPosition), aradaki tek fark
   Araba Modu'nun kullanıcının BİLİNÇLİ tercihi olması; Normal modda da
   artık hareketler anlık haritaya yansır. Araç içinde olup olmadığı
   (🚗 ikonu) ise moddan bağımsız, gerçek hıza göre OTOMATİK algılanır.
   Tasarruf Modu tek farklı davranan mod: seyrek + düşük hassasiyet. ---------- */
function startMatchLocationWatch(mode){
  stopMatchLocationWatch();
  if(!navigator.geolocation || !fbAuth.currentUser) return;
  const myUid = fbAuth.currentUser.uid;
  const writeLoc = (pos)=>{
    matchMapMyLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    fbDb.ref('userLocations/' + myUid).update(buildMatchLocUpdate(pos.coords)).catch(()=>{});
    // Eski DOM marker sistemi kalkınca konumu anlık güncellemek için
    // WebGL nokta katmanını (cache'lenmiş arkadaş listesiyle) tazeliyoruz.
    if(matchMap) renderAllMatchMarkers(matchMapLastCandidates || []);
  };
  if(mode === 'battery'){
    writeLoc({ coords: { latitude: matchMapMyLoc ? matchMapMyLoc.lat : 0, longitude: matchMapMyLoc ? matchMapMyLoc.lng : 0, heading:null, speed:null } });
    matchMapRefreshTimer = setInterval(()=>{
      navigator.geolocation.getCurrentPosition(writeLoc, ()=>{}, { enableHighAccuracy:false, timeout:15000, maximumAge:120000 });
    }, 5 * 60000); // 5 dakikada bir
  } else {
    // normal & car: ikisi de sürekli, anlık takip — konum değiştikçe
    // (GPS izin verdiği en yüksek sıklıkla) doğrudan Firebase'e yazılır.
    matchMapWatchId = navigator.geolocation.watchPosition(writeLoc, ()=>{}, { enableHighAccuracy:true, maximumAge:5000 });
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
      <div class="matchMapWeatherPill" id="matchMapWeatherPill"></div>
      <canvas id="matchMapWeatherFxCanvas" style="position:absolute;inset:0;z-index:1;pointer-events:none;"></canvas>
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
  // Harita görünmüyorken animasyon boşuna CPU/pil tüketmesin diye durduruyoruz.
  if(typeof stopMatchWeatherFx === 'function') stopMatchWeatherFx();
  matchWeatherLastFetchKey = ''; // tekrar açılışta hava durumu/efekt yeniden değerlendirilsin
  // Not: harita kapansa da konum takibi arka planda devam eder — Normal ve
  // Araba modu artık AYNI şekilde sürekli takip yapıyor (Tasarruf modu
  // kasıtlı olarak seyrek/düşük hassasiyetli çalışmaya devam ediyor).
}

/* closeTopmostOverlay() listesine elle kaydolmadan da kapanabilsin diye
   burada global bir yardımcı bırakıyoruz — index.html'deki closer
   listesine `['matchMapOverlay', ()=>closeMatchMapOverlay()]` eklenmiştir. */

/* ---------- Ayarları oku, sonra haritayı kur ---------- */
/* ============================================================
   CANLI HAVA DURUMU — Open-Meteo (ücretsiz, API anahtarı GEREKMEZ)
   Konumun için anlık sıcaklık + hava durumu ikonunu üst çubuğun
   altında küçük bir kutucukta gösterir.
   ============================================================ */
const MATCH_WEATHER_CODE_MAP = {
  0: ['☀️', 'Açık'], 1: ['🌤️', 'Az Bulutlu'], 2: ['⛅', 'Parçalı Bulutlu'], 3: ['☁️', 'Kapalı'],
  45: ['🌫️', 'Sisli'], 48: ['🌫️', 'Kırağı Sisi'],
  51: ['🌦️', 'Hafif Çisenti'], 53: ['🌦️', 'Çisenti'], 55: ['🌧️', 'Yoğun Çisenti'],
  56: ['🌧️', 'Dondurucu Çisenti'], 57: ['🌧️', 'Dondurucu Çisenti'],
  61: ['🌦️', 'Hafif Yağmur'], 63: ['🌧️', 'Yağmur'], 65: ['🌧️', 'Şiddetli Yağmur'],
  66: ['🌧️', 'Dondurucu Yağmur'], 67: ['🌧️', 'Dondurucu Yağmur'],
  71: ['🌨️', 'Hafif Kar'], 73: ['❄️', 'Kar'], 75: ['❄️', 'Yoğun Kar'], 77: ['❄️', 'Kar Taneleri'],
  80: ['🌦️', 'Sağanak'], 81: ['🌧️', 'Sağanak'], 82: ['⛈️', 'Şiddetli Sağanak'],
  85: ['🌨️', 'Kar Sağanağı'], 86: ['❄️', 'Yoğun Kar Sağanağı'],
  95: ['⛈️', 'Gök Gürültülü Fırtına'], 96: ['⛈️', 'Dolulu Fırtına'], 99: ['⛈️', 'Şiddetli Dolulu Fırtına']
};
let matchWeatherLastFetchKey = '';
function refreshMatchMapWeather(){
  // Artık SADECE kendi konumum değil, haritanın o an gösterdiği merkez
  // noktanın hava durumu gösteriliyor — harita nereye kaydırılırsa
  // oranın havası görünüyor.
  if(!matchMap) return;
  const center = matchMap.getCenter();
  const lat = center.lat, lng = center.lng;
  const pill = document.getElementById('matchMapWeatherPill');
  if(!pill) return;
  // Aynı bölge için (yaklaşık ~1km hassasiyetle) kısa sürede tekrar tekrar
  // istek atmayalım diye basit bir önbellek anahtarı.
  const fetchKey = lat.toFixed(2) + ',' + lng.toFixed(2);
  if(fetchKey === matchWeatherLastFetchKey) return;
  matchWeatherLastFetchKey = fetchKey;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`;
  fetch(url).then(r=> r.json()).then(data=>{
    const cw = data && data.current_weather;
    if(!cw) return;
    // Yanıt hâlâ geçerli mi kontrol et — kullanıcı bu sırada başka bir
    // bölgeye kaymışsa eski (artık geçersiz) sonucu göstermeyelim.
    const nowCenter = matchMap.getCenter();
    if(nowCenter.lat.toFixed(2) + ',' + nowCenter.lng.toFixed(2) !== fetchKey) return;
    const info = MATCH_WEATHER_CODE_MAP[cw.weathercode] || ['🌡️', ''];
    const temp = Math.round(cw.temperature);
    pill.innerHTML = `<span style="font-size:15px;">${info[0]}</span> ${temp}° ${escapeHtml(info[1])}`;
    pill.classList.add('visible');
    startMatchWeatherFx(matchWeatherEffectTypeFor(cw.weathercode));
  }).catch(()=>{ /* hava durumu alınamadı — sessizce yok say, harita için kritik değil */ });
}

/* ============================================================
   HAVA DURUMU ANİMASYONU — haritanın üzerine yağmur/kar efekti
   Hafif bir canvas parçacık animasyonu; haritayla etkileşimi
   ENGELLEMİYOR (pointer-events:none), sadece görsel bir katman.
   ============================================================ */
function matchWeatherEffectTypeFor(code){
  if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code)) return 'rain';
  if([71,73,75,77,85,86].includes(code)) return 'snow';
  if([95,96,99].includes(code)) return 'storm';
  return 'none';
}
let matchWeatherFxState = { type: 'none', raf: null, particles: [], resizeHandler: null };
function startMatchWeatherFx(type){
  const canvas = document.getElementById('matchMapWeatherFxCanvas');
  if(!canvas) return;
  if(matchWeatherFxState.type === type) return; // zaten aynı efekt çalışıyor
  stopMatchWeatherFx();
  matchWeatherFxState.type = type;
  if(type === 'none') return;

  const ctx = canvas.getContext('2d');
  const resize = ()=>{ canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; };
  resize();
  matchWeatherFxState.resizeHandler = resize;
  window.addEventListener('resize', resize);

  const isSnow = type === 'snow';
  const count = isSnow ? 70 : 140;
  const particles = [];
  for(let i = 0; i < count; i++){
    particles.push(isSnow ? {
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      r: 1.5 + Math.random() * 2.5, speed: 0.5 + Math.random() * 1.2,
      drift: Math.random() * 1 - 0.5, sway: Math.random() * Math.PI * 2
    } : {
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      len: 10 + Math.random() * 14, speed: 7 + Math.random() * 6,
      opacity: 0.25 + Math.random() * 0.35
    });
  }
  matchWeatherFxState.particles = particles;

  let lastFlash = 0;
  const draw = (ts)=>{
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Fırtınada ara sıra hafif bir beyaz flaş (şimşek hissi)
    if(type === 'storm' && ts - lastFlash > (3000 + Math.random() * 4000)){
      lastFlash = ts;
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if(isSnow){
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      particles.forEach(p=>{
        p.sway += 0.02;
        p.y += p.speed;
        p.x += p.drift + Math.sin(p.sway) * 0.4;
        if(p.y > canvas.height){ p.y = -5; p.x = Math.random() * canvas.width; }
        if(p.x > canvas.width) p.x = 0; else if(p.x < 0) p.x = canvas.width;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      ctx.strokeStyle = 'rgba(180,210,255,.5)';
      ctx.lineWidth = 1.3;
      particles.forEach(p=>{
        p.y += p.speed;
        p.x -= p.speed * 0.28; // hafif eğik yağmur
        if(p.y > canvas.height){ p.y = -20; p.x = Math.random() * canvas.width; }
        if(p.x < 0) p.x = canvas.width;
        ctx.globalAlpha = p.opacity;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.len * 0.28, p.y + p.len);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
    matchWeatherFxState.raf = requestAnimationFrame(draw);
  };
  matchWeatherFxState.raf = requestAnimationFrame(draw);
}
function stopMatchWeatherFx(){
  if(matchWeatherFxState.raf) cancelAnimationFrame(matchWeatherFxState.raf);
  if(matchWeatherFxState.resizeHandler) window.removeEventListener('resize', matchWeatherFxState.resizeHandler);
  const canvas = document.getElementById('matchMapWeatherFxCanvas');
  if(canvas){ const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0, 0, canvas.width, canvas.height); }
  matchWeatherFxState = { type: 'none', raf: null, particles: [], resizeHandler: null };
}

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
      trackMode: d.trackMode === 'battery' ? 'battery' : 'normal', // eski 'car' değeri de artık 'normal'a eşit davranıyor
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
    // Sürekli takip (Normal/Araba) veya Tasarruf Modu'nun arka plan
    // zamanlayıcısı, sayfa yenilenince/tekrar açılınca JS hafızasından
    // silinmiş olabilir (watchId/timer sadece o oturuma özeldi). Harita
    // her açıldığında, paylaşım açıksa takibi burada YENİDEN başlatıyoruz
    // ki "hep takip etsin" beklentisi sayfa yenilense bile bozulmasın.
    if(matchMapMySettings.sharing && matchMapWatchId === null && !matchMapRefreshTimer){
      startMatchLocationWatch(matchMapMySettings.trackMode || 'normal');
    }
    initMatchMapInstance();
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        (pos)=>{
          matchMapMyLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          fbDb.ref('userLocations/' + myUid).update(buildMatchLocUpdate(pos.coords)).catch(()=>{});
          const applyFreshLoc = ()=>{
            matchMap.jumpTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 13.5, pitch: (matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0), bearing: 0 });
            renderAllMatchMarkers(matchMapLastCandidates || []);
            refreshMatchMapWeather();
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
    center, zoom: 13.5, pitch: (matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0), bearing: 0, attributionControl: false,
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
    applyMatchMapHolidayTheme(); // hem temayı tespit eder hem doğru paleti uygular
    ensureMatchGlobeLayer();
    updateMatchMapPitchForZoom();
    // Konum henüz gelmemişken harita varsayılan (Türkiye ortası) merkezle
    // açılmış olabilir — gerçek konum eldeyse sokak seviyesinde ortalayarak
    // asla geniş/uzak bir dünya görünümünde takılı kalmamasını sağlıyoruz.
    if(matchMapMyLoc){
      matchMap.jumpTo({ center: [matchMapMyLoc.lng, matchMapMyLoc.lat], zoom: 13.5, pitch: (matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0), bearing: 0 });
    }
    refreshNearbyMatchUsers();
    refreshMatchMapWeather();
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
    updateMatchMapPitchForZoom();
  });
  // 'zoomend' elle (parmakla) yakınlaştırıp uzaklaştırmada güvenilir
  // tetikleniyor, ama flyTo() gibi ANİMASYONLU/programatik kamera
  // hareketlerinde (ör. "Konuma Git" butonu) her zaman tetiklenmeyebiliyor
  // — bu da marker'ların (DOM ↔ WebGL) yeniden çizilmeden eski/yanlış
  // konumda kalmasına yol açıyordu. 'moveend' HER kamera hareketinin
  // (flyTo, easeTo, jumpTo, elle sürükleme/zoom — hepsi) bitişinde
  // güvenilir şekilde tetiklendiği için ek bir güvence olarak kullanıyoruz.
  matchMap.on('moveend', ()=>{ renderAllMatchMarkers(matchMapLastCandidates || []); refreshMatchMapWeather(); });
  updateMatchMapStyleToggleUI();
}

/* Mapbox Standard stilinin kendi gece temasını (lightPreset) uygular —
   klasik dark-v11'deki gibi elle katman katman boyamak yerine, Standard
   stilin yerleşik "night" ışık ayarını kullanıyoruz. Uydu modunda (raster
   gerçek görüntü) bu ayarın etkisi yok, güvenle atlanır. */
function applyMatchMap3DTheme(){
  if(!matchMap || matchMapStyleKey !== 'dark') return;
  try{
    // dark-v11 klasik bir stil — "Standard" stilin setConfigProperty API'sini
    // desteklemiyor. Onun yerine binalara gerçek bir fill-extrusion (3D
    // yükseklik) katmanı ekliyoruz; harita zaten sabit bir açıyla (pitch)
    // açıldığı için bu yükseklik gerçekten görünür oluyor.
    if(!matchMap.getLayer('match-3d-buildings')){
      // Katmanı, sembol/etiket katmanlarının ALTINA (ilk sembol katmanının
      // hemen öncesine) ekliyoruz ki bina hacimleri yol/yer isimlerini
      // örtüp okunmaz hale getirmesin.
      let firstSymbolId;
      const layers = matchMap.getStyle().layers || [];
      for(const l of layers){ if(l.type === 'symbol'){ firstSymbolId = l.id; break; } }
      matchMap.addLayer({
        id: 'match-3d-buildings',
        source: 'composite',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': '#2A3550',
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 12],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.85
        }
      }, firstSymbolId);
    }
  }catch(e){ /* stil henüz tam hazır değilse veya 'building' kaynağı yoksa sessizce geç */ }
}

/* Küre (dünya) görünümündeyken 3D açı (pitch) uygulanırsa küre çarpık/
   yamuk görünüyor — bu yüzden SADECE yakın (şehir/sokak) zoom'da 3D açı
   kullanılmalı, küre zoom'unda harita düz (pitch:0) kalmalı. Zoom eşiğini
   geçince aralarında yumuşak bir geçiş yapıyoruz. */
const MATCH_MAP_GLOBE_ZOOM_THRESHOLD = 4;
function updateMatchMapPitchForZoom(){
  if(!matchMap || matchMapStyleKey !== 'dark') return;
  const zoom = matchMap.getZoom();
  const wantPitch = zoom < MATCH_MAP_GLOBE_ZOOM_THRESHOLD ? 0 : MATCH_MAP_3D_PITCH;
  if(Math.abs(matchMap.getPitch() - wantPitch) > 1){
    matchMap.easeTo({ pitch: wantPitch, duration: 400 });
  }
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

/* ============================================================
   ARAÇ İÇİNDE (isDriving) OLAN KULLANICILAR İÇİN GERÇEK ARAÇ GÖRSELİ
   ------------------------------------------------------------
   Moddan bağımsız — sadece gerçek anlık hıza göre otomatik seçiliyor
   (bkz. buildMatchLocUpdate / setMatchGlobeLayerData). Görsel, harici bir
   dosyaya bağımlı kalmasın diye base64 olarak doğrudan koda gömülü;
   arka planı kaldırılmış/kırpılmış halde saklanıyor. Nokta ikonundan
   (20px) belirgin şekilde BÜYÜK gösteriliyor ki görünürlüğü iyi olsun. */
const MATCH_CAR_ICON_SRC = 'data:image/png;base64,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';
const MATCH_CAR_IMAGE_ID = 'matchcar-icon';
const MATCH_CAR_IMAGE_SIZE = 72;   // texture çözünürlüğü (retina netliği için nokta ikonundan daha büyük)
const MATCH_CAR_DISPLAY_SIZE = 34; // haritada görünecek gerçek piksel boyutu — MATCH_DOT_DISPLAY_SIZE'dan (20px) belirgin büyük
let matchCarIconImg = null;
let matchCarIconReady = false;
(function preloadMatchCarIcon(){
  const img = new Image();
  img.onload = ()=>{
    matchCarIconImg = img;
    matchCarIconReady = true;
    // Görsel geç yüklendiyse (nadir bir durum — data URI olduğu için
    // normalde neredeyse anında hazır olur), olası geçici yer tutucuyu
    // gerçek fotoğrafla değiştirip haritayı tazeliyoruz.
    if(matchMap){
      try{
        if(matchMap.hasImage(MATCH_CAR_IMAGE_ID)) matchMap.removeImage(MATCH_CAR_IMAGE_ID);
        matchMap.addImage(MATCH_CAR_IMAGE_ID, generateMatchCarImageData());
        if(typeof renderAllMatchMarkers === 'function') renderAllMatchMarkers(matchMapLastCandidates || []);
      }catch(e){}
    }
  };
  img.src = MATCH_CAR_ICON_SRC;
})();
function generateMatchCarImageData(){
  const size = MATCH_CAR_IMAGE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = size * 0.14;
  ctx.shadowOffsetY = size * 0.035;
  if(matchCarIconReady && matchCarIconImg){
    // Gerçek araç fotoğrafını en-boy oranını koruyarak, kenara az boşluk
    // bırakıp mümkün olduğunca büyük çiziyoruz (görünürlük önceliği).
    const iw = matchCarIconImg.width, ih = matchCarIconImg.height;
    const scale = Math.min((size * 0.96) / iw, (size * 0.96) / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(matchCarIconImg, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    // Görsel henüz yüklenmediyse (ilk milisaniyelerde) geçici emoji göster.
    ctx.font = Math.round(size * 0.6) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚗', cx, cy + 1);
  }
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}
function ensureMatchDotImages(){
  if(!matchMap) return;
  if(!matchDotImagesReady){
    ['#FF3B30', '#3B82F6', '#FFFFFF'].forEach(color=>{
      const id = matchDotImageIdFor(color);
      if(!matchMap.hasImage(id)) matchMap.addImage(id, generateMatchDotImageData(color, color === '#FFFFFF'));
    });
    matchDotImagesReady = true;
  }
  if(!matchMap.hasImage(MATCH_CAR_IMAGE_ID)) matchMap.addImage(MATCH_CAR_IMAGE_ID, generateMatchCarImageData());
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
        'icon-size': ['case', ['==', ['get', 'iconKind'], 'car'], MATCH_CAR_DISPLAY_SIZE / MATCH_CAR_IMAGE_SIZE, MATCH_DOT_DISPLAY_SIZE / MATCH_DOT_IMAGE_SIZE],
        'icon-offset': ['get', 'offset'],  // [x,y] piksel — icon-size ile ölçekleniyor
        'icon-rotate': ['coalesce', ['get', 'heading'], 0], // araç ikonu, varsa gerçek harekete göre döner
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      }
    });
    matchMap.on('click', MATCH_GLOBE_LAYER_ID, (e)=>{
      // Aynı pikselde tam üstüne binen bir kutu (hediye) marker'ı varsa,
      // kişi profilini AÇMA — kutu zaten kendi tıklamasını yönetiyor
      // (stopPropagation ile). Bu ikisinin aynı anda açılıp üst üste
      // binmesini önlüyor.
      const clickedEl = e.originalEvent && e.originalEvent.target;
      if(clickedEl && clickedEl.closest && clickedEl.closest('.matchBoxDot')) return;
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
      const isDriving = !!(c.loc && c.loc.isDriving === true);
      const heading = (c.loc && typeof c.loc.heading === 'number') ? c.loc.heading : 0;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.loc.lng, c.loc.lat] },
        properties: {
          uid: c.uid,
          isMe: !!c.isMe,
          iconId: isDriving ? MATCH_CAR_IMAGE_ID : matchDotImageIdFor(color),
          iconKind: isDriving ? 'car' : 'dot',
          heading,
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
    applyMatchMapHolidayTheme(); // hem temayı tespit eder hem doğru paleti uygular
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
    matchMap.flyTo({ center: [lng, lat], zoom: 13.5, pitch: (matchMapStyleKey === 'dark' ? MATCH_MAP_3D_PITCH : 0), bearing: 0 });
    matchMap.once('moveend', ()=>{ renderAllMatchMarkers(matchMapLastCandidates || []); });
    refreshMatchMapWeather();
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
  text: '#FFFFFF',      // Beyaz — metinler
  textHalo: '#18181C',
  skipBuilding: false
};
/* Yıl başı teması — verilen hex kodlarıyla. Evler (binalar) BİLEREK
   dokunulmuyor, stilin kendi orijinal rengiyle kalıyor. */
const MATCH_MAP_PALETTE_NEWYEAR = {
  bg: '#0B1638',        // Gece laciverti — ana zemin
  water: '#8ED8FF',      // Buz mavisi — denizler / soğuk kış hissi
  roadThin: '#FFD66B',   // Altın — küçük yollar / önemli noktalar ✨
  roadMain: '#E63946',   // Kırmızı — tüm yol rotaları
  land: '#182348',       // Genel arazi/kara — zemine yakın, koyu (baskın olmasın diye)
  landLight: '#F8FAFF',  // Beyaz — SADECE gerçek park/çimen alanları (kar örtüsü hissi)
  text: '#FFFFFF',
  textHalo: '#7657D9',   // Az miktarda mor — büyülü bir parıltı hissi (yazı çevresinde)
  skipBuilding: true      // Evler orijinal renginde kalsın
};
/* Ramazan Bayramı — "Gece Bayramı Haritası": gece modu + bayram ışıkları hissi. */
const MATCH_MAP_PALETTE_RAMADAN = {
  bg: '#0A1628',
  water: '#061428',
  roadThin: '#8B7355',   // tali yollar
  roadMain: '#C9A66B',   // ana yollar — mat altın
  land: '#132A3E',
  landLight: '#132A3E',
  text: '#E8E6E1',
  textHalo: '#0A1628',
  pin: '#E8C547',         // pin/marker rengi — hafif glow ile
  skipBuilding: false
};
/* Paskalya (Ostern) — açık, canlı, bahar temalı. */
const MATCH_MAP_PALETTE_EASTER = {
  bg: '#0A1628',
  water: '#81D4FA',
  roadThin: '#F48FB1',   // tali yollar — canlı pembe
  roadMain: '#7E57C2',   // ana yollar — orta mor
  land: '#C8DCC0',       // Genel arazi — yumuşak adaçayı yeşili (baskın beyaz olmasın diye)
  landLight: '#FDE7A8',  // SADECE gerçek park/çimen alanları — pastel sarı (nergis/bahar güneşi hissi)
  text: '#37474F',
  textHalo: '#FDE7A8',
  pin: '#FFD54F',         // parlak sarı + turkuaz vurgu (#4DD0E1)
  pinAccent: '#4DD0E1',
  skipBuilding: false
};
/* Cadılar Bayramı — koyu, ürkütücü, turuncu vurgulu. */
const MATCH_MAP_PALETTE_HALLOWEEN = {
  bg: '#1A0F1F',
  water: '#0F1A2E',
  roadThin: '#E07A3D',   // tali yollar — mat turuncu
  roadMain: '#FF6B00',   // ana yollar — canlı turuncu
  land: '#2A1F2D',
  landLight: '#2A1F2D',
  text: '#F5E8C7',
  textHalo: '#1A0F1F',
  pin: '#FF8C00',         // pin/marker — parlak turuncu + siyah
  selectedRoute: '#39FF14', // seçili rota — zehirli yeşil
  skipBuilding: false
};

const MATCH_MAP_HOLIDAY_PALETTES = {
  newyear: MATCH_MAP_PALETTE_NEWYEAR,
  ramadan: MATCH_MAP_PALETTE_RAMADAN,
  easter: MATCH_MAP_PALETTE_EASTER,
  halloween: MATCH_MAP_PALETTE_HALLOWEEN
};

function applyMatchMapColorPalette(themeId){
  if(!matchMap || matchMapStyleKey !== 'dark') return;
  const palette = MATCH_MAP_HOLIDAY_PALETTES[themeId] || MATCH_MAP_PALETTE;
  let layers = [];
  try{ layers = matchMap.getStyle().layers || []; }catch(e){ return; }
  layers.forEach(layer=>{
    const id = (layer.id || '').toLowerCase();
    const src = (layer['source-layer'] || '').toLowerCase();
    const key = id + ' ' + src;
    try{
      if(layer.type === 'background'){
        matchMap.setPaintProperty(layer.id, 'background-color', palette.bg);
      } else if(layer.type === 'fill'){
        if(key.includes('water')) matchMap.setPaintProperty(layer.id, 'fill-color', palette.water);
        else if(key.includes('building')){
          if(!palette.skipBuilding) matchMap.setPaintProperty(layer.id, 'fill-color', palette.bgAlt);
        }
        else if(key.includes('park') || key.includes('grass'))
          matchMap.setPaintProperty(layer.id, 'fill-color', palette.landLight);
        else if(key.includes('land') || key.includes('landuse') || key.includes('wood') || key.includes('vegetation'))
          matchMap.setPaintProperty(layer.id, 'fill-color', palette.land);
      } else if(layer.type === 'line'){
        if(key.includes('road') || key.includes('bridge') || key.includes('tunnel')){
          const isMajor = key.includes('motorway') || key.includes('trunk') || key.includes('primary') || key.includes('secondary');
          matchMap.setPaintProperty(layer.id, 'line-color', isMajor ? palette.roadMain : palette.roadThin);
        } else if(key.includes('water') || key.includes('river') || key.includes('stream')){
          matchMap.setPaintProperty(layer.id, 'line-color', palette.water);
        }
      } else if(layer.type === 'symbol'){
        matchMap.setPaintProperty(layer.id, 'text-color', palette.text);
        matchMap.setPaintProperty(layer.id, 'text-halo-color', palette.textHalo || palette.bgAlt || '#000');
      }
    }catch(e){ /* bu katman ilgili boya özelliğini desteklemiyor olabilir — yok say */ }
  });
}

/* ---------- Bayram teması (appConfig/mapTheme) ----------
   Hangi bayram/tema aktifse (yıl başı, ramazan, cadılar bayramı, paskalya)
   tespit edip artık HEPSİ için gerçek katman renklendirmesi uyguluyor
   (eskiden sadece yıl başında vardı, diğerleri kaba bir CSS filtresiyle
   idare ediyordu). */
function applyMatchMapHolidayTheme(){
  const canvas = document.getElementById('matchMapCanvas');
  fbDb.ref('appConfig/mapTheme').once('value').then(snap=>{
    const cfg = snap.val() || {};
    let themeId = '';
    if(cfg.mode === 'manual'){
      themeId = cfg.themeId || '';
    } else {
      themeId = detectAutoHolidayTheme();
    }
    // Artık dört bayram/tema için de (yıl başı, ramazan, cadılar bayramı,
    // paskalya) gerçek katman renklendirmesi var — kaba CSS filtresine
    // hiç gerek kalmadı.
    applyMatchMapColorPalette(themeId);
    if(canvas) canvas.style.filter = '';
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

const MATCH_BOX_LIFETIME_MS = 24 * 60 * 60 * 1000; // Kutular 24 saat sonra kaybolur
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
    const myExpiredBoxIds = []; // kendi kutularımdan süresi dolmuş olanlar — gerçekten sileceğiz
    const now = Date.now();
    Object.keys(all).forEach(boxId=>{
      const b = all[boxId];
      if(!b || typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.media) return;
      // 24 saatten eski kutular artık kimseye gösterilmiyor (fotoğraf "kaybolmuş" olur).
      if(!b.ts || (now - b.ts) > MATCH_BOX_LIFETIME_MS){
        if(b.uid === myUid) myExpiredBoxIds.push(boxId);
        return;
      }
      if(b.uid !== myUid && isMutuallyBlocked(b.uid)) return;
      const isMutual = myFollows.has(b.uid) && myFollowers.has(b.uid);
      const vis = b.visibility || 'public';
      if(b.uid !== myUid){
        if(vis === 'mutual'){ if(!isMutual) return; }
        else if(vis === 'except'){ if(!isMutual) return; if((b.excludedUids || {})[myUid]) return; }
        else if(vis !== 'public'){ return; }
      }
      const dist = haversineKm(matchMapMyLoc.lat, matchMapMyLoc.lng, b.lat, b.lng);
      if(dist > MATCH_MAP_MAX_DISTANCE_KM) return; // mesafe sınırı kaldırıldı — kişi listesindeki sınırla tutarlı
      list.push({ boxId, box: b, dist });
    });
    // Kendi süresi dolmuş kutularımı Firebase'den de gerçekten siliyorum
    // (sadece kutu sahibinin cihazı silme izni var — güvenlik kuralı bunu
    // gerektirir). Böylece zamanla veritabanında da yer tutmaz.
    myExpiredBoxIds.forEach(boxId=>{ fbDb.ref('mapBoxes/' + boxId).remove().catch(()=>{}); });
    list.sort((a,b)=> a.dist - b.dist);
    return list.slice(0, 60);
  });
}

function refreshNearbyMapBoxes(){
  loadNearbyMapBoxes().then(list=>{
    const ownerUids = [...new Set(list.map(item=> item.box.uid))];
    return fetchProfilesFor(ownerUids).then(profiles=>{
      list.forEach(item=>{ item.ownerProfile = profiles[item.box.uid] || {}; });
      matchMapBoxesLastList = list;
      renderAllMatchBoxMarkers(list);
    });
  }).catch(()=>{});
}

class MatchBoxMarker {
  constructor(item, pixelOffset){
    this.item = item;
    this.el = this._buildEl();
    this.marker = new mapboxgl.Marker({ element: this.el, anchor: 'center', offset: pixelOffset || [0, 0] })
      .setLngLat([item.box.lng, item.box.lat]);
  }
  _buildEl(){
    // Haritada tıklanabilir küçük bir "hediye kutusu" ikonu — sahibinin
    // cinsiyetine göre renk tonu değişiyor (kız: orijinal kırmızı/altın,
    // erkek: maviye çevrilmiş). İçerik yalnızca dokununca (unbox) açılıyor.
    const el = document.createElement('div');
    el.className = 'matchBoxDot';
    const gender = (this.item.ownerProfile || {}).gender;
    if(gender === 'male') el.style.filter = 'hue-rotate(190deg) saturate(1.15) drop-shadow(0 0 5px rgba(59,130,246,.55))';
    el.title = 'Kutu';
    el.addEventListener('click', (e)=>{
      e.stopPropagation(); // alttaki kişi noktası katmanına tıklamanın sızmasını engelle
      openMatchBoxPreview(this.item.boxId, this.item);
    });
    return el;
  }
  addTo(map){ this.marker.addTo(map); return this; }
  remove(){ try{ this.marker.remove(); }catch(e){} }
}

/* Aynı noktadaki N kutuyu küçük bir sırada, sabit piksel kaydırmasıyla
   dizer — kişi marker'larındaki aynı mantık, üst üste binip birbirini
   gizlememeleri için. */
function computeMatchBoxPixelOffsets(count){
  if(count <= 1) return [[0, 0]];
  const spacing = 26; // px
  const totalWidth = (count - 1) * spacing;
  const startX = -totalWidth / 2;
  const offsets = [];
  for(let i = 0; i < count; i++) offsets.push([startX + i * spacing, 0]);
  return offsets;
}

function renderAllMatchBoxMarkers(list){
  if(!matchMap) return;
  Object.values(matchBoxMarkers).forEach(m=> m.remove());
  matchBoxMarkers = {};
  // Kutu verisini kümeleme fonksiyonunun beklediği {loc:{lat,lng}} biçimine
  // uyarlayıp, ekranda üst üste binenleri (aynı gruptaki) hafifçe yana
  // kaydırarak diziyoruz — hiçbiri birbirinin üstüne binip kaybolmuyor.
  const withLoc = list.map(item=> Object.assign({}, item, { loc: { lat: item.box.lat, lng: item.box.lng } }));
  const groups = clusterCandidatesByPixelDistance(withLoc);

  // ÖNEMLİ: kutular sadece kendi aralarında değil, KİŞİ noktalarıyla da
  // çakışabiliyor (biri kutunun tam üstünde duruyorsa sadece birine
  // dokunulabiliyordu). Şu an ekranda gösterilen tüm kişilerin piksel
  // konumlarını çıkarıp, bir kutu onlardan birine çok yakınsa kutuyu sabit
  // bir miktar kaydırıyoruz — kişinin konumuna DOKUNMUYORUZ (o gerçek GPS
  // konumunu göstermeye devam etmeli), sadece kutu kenara çekiliyor.
  const personScreenPoints = [];
  if(matchMapMyLoc){
    try{ personScreenPoints.push(matchMap.project([matchMapMyLoc.lng, matchMapMyLoc.lat])); }catch(e){}
  }
  (matchMapLastCandidates || []).forEach(c=>{
    try{ personScreenPoints.push(matchMap.project([c.loc.lng, c.loc.lat])); }catch(e){}
  });
  const PERSON_COLLISION_PX = 26;

  groups.forEach(group=>{
    const offsets = computeMatchBoxPixelOffsets(group.length);
    group.forEach((item, i)=>{
      let offset = offsets[i];
      try{
        const boxScreenPt = matchMap.project([item.box.lng, item.box.lat]);
        const collidesWithPerson = personScreenPoints.some(p=>{
          const dx = (boxScreenPt.x + offset[0]) - p.x;
          const dy = (boxScreenPt.y + offset[1]) - p.y;
          return Math.sqrt(dx*dx + dy*dy) < PERSON_COLLISION_PX;
        });
        if(collidesWithPerson) offset = [offset[0] + 24, offset[1] - 24]; // sağ-üste kaydır
      }catch(e){}
      matchBoxMarkers[item.boxId] = new MatchBoxMarker(item, offset).addTo(matchMap);
    });
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

        <div style="display:flex;align-items:center;gap:6px;margin-top:14px;padding:0 2px;font-size:11.5px;color:var(--muted);">
          <span>⏱️</span><span>${escapeHtml(t('match_box_expires_notice'))}</span>
        </div>
        <button class="btn" id="matchBoxSubmitBtn" style="width:100%;margin-top:12px;padding:15px;border-radius:16px;border:none;background:var(--gradient-vivid);color:#fff;font-weight:800;font-size:14.5px;" onclick="submitMatchBox()">📦 ${escapeHtml(t('match_box_submit'))}</button>
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
/* ============================================================
   +18 İÇERİK TESPİTİ — NSFWJS (ücretsiz, tarayıcı içinde çalışır,
   API anahtarı GEREKMEZ, hiçbir fotoğraf dışarıya gönderilmez).
   ============================================================ */
let matchNsfwModelPromise = null;
let matchNsfwScriptsPromise = null;
function ensureNsfwScriptsLoaded(){
  if(matchNsfwScriptsPromise) return matchNsfwScriptsPromise;
  const loadScript = (src)=> new Promise((resolve, reject)=>{
    if(document.querySelector(`script[src="${src}"]`)){ resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  matchNsfwScriptsPromise = loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js')
    .then(()=> loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@2.4.2/dist/nsfwjs.min.js'));
  return matchNsfwScriptsPromise;
}
function ensureNsfwModel(){
  if(matchNsfwModelPromise) return matchNsfwModelPromise;
  matchNsfwModelPromise = ensureNsfwScriptsLoaded().then(()=> window.nsfwjs.load());
  return matchNsfwModelPromise;
}
/* dataUrlOrObjectUrl: bir <img> ile açılabilecek herhangi bir görsel kaynağı.
   Sonuç: { flagged: bool, reason: 'Porn'|'Hentai'|null } */
function checkImageForNsfw(imgSrc){
  return ensureNsfwModel().then(model=>{
    return new Promise((resolve)=>{
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = ()=>{
        model.classify(img).then(predictions=>{
          const bad = predictions.find(p=> (p.className === 'Porn' || p.className === 'Hentai') && p.probability > 0.72);
          resolve({ flagged: !!bad, reason: bad ? bad.className : null });
        }).catch(()=> resolve({ flagged: false, reason: null }));
      };
      img.onerror = ()=> resolve({ flagged: false, reason: null });
      img.src = imgSrc;
    });
  }).catch(()=> ({ flagged: false, reason: null })); // model yüklenemezse engellemeden geç (kritik değil)
}
/* +18 içerik tespit edilince: uyarı sayacını artır, 3'e ulaşınca hesabı kilitle. */
function reportNsfwViolationAndCheckLock(){
  if(!fbAuth.currentUser) return Promise.resolve(false);
  const uid = fbAuth.currentUser.uid;
  const ref = fbDb.ref('users/' + uid + '/nsfwWarnings');
  return ref.transaction(cur=> (cur || 0) + 1).then(res=>{
    const count = (res.snapshot && res.snapshot.val()) || 1;
    if(count >= 3){
      fbDb.ref('users/' + uid + '/blocked').set(true).catch(()=>{});
      return true; // hesap kilitlendi
    }
    return false;
  }).catch(()=> false);
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
  const rejectAsNsfw = ()=>{
    reportNsfwViolationAndCheckLock().then(lockedNow=>{
      if(lockedNow){
        showToast('⚠️ 3. uygunsuz içerik uyarısını aldın, hesabın kilitlendi.');
        setTimeout(()=>{ closeMatchBoxComposer(); closeMatchMapOverlay(); fbAuth.signOut(); }, 1800);
      } else {
        showToast('⚠️ Bu fotoğraf uygunsuz (+18) içerik içeriyor, paylaşılamaz.');
        resetBtn();
      }
    });
  };
  if(matchBoxComposerType === 'video'){
    // Video için kare-kare NSFW taraması yapmıyoruz (maliyetli); şimdilik
    // sadece fotoğraflar taranıyor.
    if(!fbStorage){ showToast(t('toast_video_needs_storage2') || 'Video için depolama kullanılamıyor.'); resetBtn(); return; }
    const path = 'mapBoxes/' + myUid + '/' + Date.now() + '.mp4';
    fbStorage.ref().child(path).put(matchBoxComposerFile)
      .then(s=> s.ref.getDownloadURL()).then(finish)
      .catch(()=>{ showToast(t('toast_video_upload_fail') || 'Video yüklenemedi.'); resetBtn(); });
  } else {
    const reader = new FileReader();
    reader.onload = ()=>{
      const dataUrl = reader.result;
      checkImageForNsfw(dataUrl).then(result=>{
        if(result.flagged){ rejectAsNsfw(); return; }
        (typeof compressForPost === 'function' ? compressForPost(dataUrl) : Promise.resolve(dataUrl)).then(finish);
      });
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
  // Rozet kademeleri:
  // - Rozeti YOK (null): kutunun içindeki görseli/videoyu görebilir,
  //   ama kutuyu bırakan kişinin profil fotoğrafını ve kullanıcı adını
  //   GÖREMEZ (kimlik gizli kalır).
  // - Standart rozet (blue): kimliği (foto + kullanıcı adı) de görür,
  //   ama mesaj YAZAMAZ ve takip EDEMEZ.
  // - Plus/Premium (gold/purple): her şeyi görür + mesaj yazabilir + takip edebilir.
  const canSeeIdentity = savedVerifiedTier === 'blue' || savedVerifiedTier === 'gold' || savedVerifiedTier === 'purple';
  const canInteract = savedVerifiedTier === 'gold' || savedVerifiedTier === 'purple'; // mesaj + takip
  const hasAccess = canInteract; // eski adlandırma korunuyor
  const isOwn = fbAuth.currentUser && b.uid === fbAuth.currentUser.uid;
  const showIdentity = canSeeIdentity || isOwn;
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

    // Kimlik bloğu: rozeti yoksa foto+kullanıcı adı yerine bulanık/kilit
    // görünümü gösterilir; kutunun kendi görseli/videosu bundan ETKİLENMEZ.
    const identityHtml = showIdentity ? `
      <div style="display:flex;align-items:center;gap:14px;">
        <img src="${smallAvatar}" onerror="this.src='default-avatar.png'" style="width:60px;height:60px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--glass-border);">
        <div>
          <div style="font-size:17px;font-weight:800;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(profile.displayName || profile.username || '@kullanici')} ${typeof verifiedBadgeHtml === 'function' ? verifiedBadgeHtml(profile.verifiedTier, 15) : ''}</div>
          <div style="font-size:12.5px;color:var(--accent);margin-top:3px;">📍 ${escapeHtml(distText)} · ${escapeHtml(formatPostAge(b.ts))}</div>
        </div>
      </div>` : `
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="matchLockedBlur" style="width:60px;height:60px;border-radius:50%;flex-shrink:0;background-image:url('${smallAvatar}');background-size:cover;background-position:center;"></div>
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;color:var(--text);font-family:'Space Grotesk',sans-serif;">${escapeHtml(t('match_identity_locked_title') || '🔒 Kimlik gizli')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px;line-height:1.4;">${escapeHtml(t('match_identity_locked_desc') || 'Kutuyu kimin bıraktığını görmek için bir rozet gerekiyor.')}</div>
          <button class="btn btn-primary" style="margin-top:9px;padding:7px 16px;font-size:11.5px;border-radius:10px;" onclick="closeMatchBoxPreview();openMatchVerifiedBadgeInfoForBox('${boxId}');">${escapeHtml(t('match_upgrade_btn'))}</button>
        </div>
      </div>`;

    wrap.innerHTML = `
      ${identityHtml}
      ${b.title ? `<div style="font-size:14px;color:var(--text);margin:14px 0 0;font-weight:600;">${escapeHtml(b.title)}</div>` : ''}

      <div style="margin-top:16px;border-radius:16px;overflow:hidden;background:var(--surface-2);">
        ${matchBoxMediaHtml(b)}
      </div>

      ${isOwn ? `
        <button class="btn" style="width:100%;margin-top:18px;padding:14px;border-radius:16px;border:1.5px solid var(--danger);background:rgba(237,73,86,.12);color:var(--danger);font-weight:800;" onclick="deleteMatchBox('${boxId}')">🗑️ ${escapeHtml(t('match_box_delete'))}</button>
      ` : `
        <div style="display:flex;gap:10px;margin-top:18px;">
          <button class="btn ${canInteract ? '' : 'btn-ghost'}" id="matchFollowBtn" style="flex:1;${canInteract ? 'background:var(--gradient-vivid);color:#fff;border:none;' : ''}" onclick="${canInteract ? `matchFollowUser('${b.uid}', true)` : `closeMatchBoxPreview();openMatchVerifiedBadgeInfoForBox('${boxId}');`}">
            ${canInteract ? escapeHtml(t('match_follow_btn')) : '🔒 ' + escapeHtml(t('match_follow_btn'))}
          </button>
          <button class="btn ${hasAccess ? '' : 'btn-ghost'}" style="flex:1;${hasAccess ? 'background:var(--surface-2);color:var(--text);border:1px solid var(--line);' : ''}" onclick="${hasAccess ? `matchMessageUser('${b.uid}', '${boxId}')` : `closeMatchBoxPreview();openMatchVerifiedBadgeInfoForBox('${boxId}');`}">
            ${hasAccess ? '💬 ' + escapeHtml(t('match_message_btn')) : '🔒 ' + escapeHtml(t('match_message_btn'))}
          </button>
        </div>
      `}
    `;
    // Takip durumu sadece etkileşim izni olanlar için sorgulanır — aksi
    // halde kilitli buton metni "Takip Et/Ediliyor" ile ezilirdi.
    if(!isOwn && canInteract) refreshMatchFollowButtonState(b.uid);
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
    // Yön oku: heading değeri geldiyse (artık Normal modda da sürekli
    // takip olduğu için her modda gelebilir) göster — artık sadece
    // Araba Modu'na özel değil.
    const heading = (typeof this.candidate.loc.heading === 'number') ? this.candidate.loc.heading : null;
    // Araç içinde mi? Moddan bağımsız, gerçek anlık hıza göre sunucu
    // tarafında (buildMatchLocUpdate) otomatik hesaplanan bayrak — eşiği
    // aşan herkes moddan bağımsız 🚗 ikonuyla gösterilir.
    const isDriving = this.candidate.loc.isDriving === true;
    el.innerHTML = `
      <div class="snapMarkerName">${name}</div>
      <div class="snapMarkerRing" style="--ring-color:${color}">
        ${heading !== null ? `<div class="snapMarkerHeadingArrow" style="transform:translateX(-50%) rotate(${heading}deg)"></div>` : ''}
        ${isDriving
          ? `<div class="snapMarkerCarIcon">🚗</div>`
          : `<img src="${photo}" onerror="this.src='default-avatar.png'">`}
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
      loc: {
        lng: matchMapMyLoc.lng, lat: matchMapMyLoc.lat, updatedAt: Date.now(),
        heading: matchMapMyHeading, isDriving: matchMapMyIsDriving
      },
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
function matchFollowUser(uid, boxCtx){
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
        // Kutudan takip edildiyse bildirimde bunu belirt ("kutundan seni
        // takip etti" gibi) — normal haritadan takipse standart metin.
        if(typeof sendFollowNotification === 'function') sendFollowNotification(uid, boxCtx ? 'box' : undefined);
      });
    }
  });
}

/* Haritadan mesaj gönderme: karşılıklı takipse doğrudan sohbete gir;
   değilse (ve karşı taraf mesaj onayını kapatmadıysa) "onay bekliyor"
   durumunda bir sohbet isteği oluşturur.
   boxCtx verilmişse (kutu önizlemesinden gelindiyse), sohbete GİRMEDEN
   önce "📦 Kutuna yanıt verdi" tarzı bir ilk mesaj gönderiyoruz — böylece
   konuşmanın o kutu paylaşımına cevap olarak başladığı sohbet ekranında
   belli oluyor (hikaye yanıtlarındaki aynı mantık). */
function matchMessageUser(uid, boxId){
  if(!fbAuth.currentUser) return;
  const myUid = fbAuth.currentUser.uid;
  // Inline onclick'ten güvenli olsun diye sadece boxId (düz metin) alıyoruz;
  // başlık gibi özel karakter içerebilecek veriyi burada, hafızadaki güncel
  // listeden buluyoruz (HTML attribute'una gömüp kaçış sorunu yaşamamak için).
  const boxItem = boxId ? matchMapBoxesLastList.find(i=> i.boxId === boxId) : null;
  const boxCtx = boxId ? { boxId, title: boxItem && boxItem.box ? boxItem.box.title : '' } : null;
  Promise.all([
    fbDb.ref('follows/' + myUid + '/' + uid).once('value'),
    fbDb.ref('followers/' + myUid + '/' + uid).once('value'),
    fbDb.ref('users/' + uid + '/matchMsgApprovalOn').once('value')
  ]).then(([followsSnap, followersSnap, approvalSnap])=>{
    const isMutual = followsSnap.exists() && followersSnap.exists();
    const approvalRequired = approvalSnap.val() !== false; // varsayılan: açık
    if(isMutual || !approvalRequired){
      closeMatchProfilePreview();
      closeMatchBoxPreview();
      closeMatchMapOverlay();
      if(boxCtx){
        sendMatchBoxReplyOpener(uid, myUid, boxCtx).then(()=> goToMatchChatSafely(uid));
      } else {
        goToMatchChatSafely(uid);
      }
      return;
    }
    sendMatchMessageRequest(uid);
  });
}

/* Kutuya "cevap" niteliğinde otomatik açılış mesajı — sendStoryReply ile
   aynı desende (chats/{chatId}/messages + chatMeta güncellemesi). */
function sendMatchBoxReplyOpener(ownerUid, myUid, boxCtx){
  const chatId = [myUid, ownerUid].sort().join('_');
  const msgRef = fbDb.ref('chats/' + chatId + '/messages').push();
  const ts = Date.now();
  const label = '📦 ' + (boxCtx.title ? ('"' + boxCtx.title + '"') : t('match_box_composer_title')) + ' kutusuna yanıt verdi';
  return (typeof ensureChatMeta === 'function' ? ensureChatMeta(chatId, ownerUid) : Promise.resolve()).then(()=>{
    return msgRef.set({ from: myUid, text: label, ts, boxReply: true, boxId: boxCtx.boxId || null });
  }).then(()=>{
    const update = { lastMsg: label, lastTs: ts, lastSenderUid: myUid };
    update['unreadFor/' + ownerUid] = true;
    return fbDb.ref('chatMeta/' + chatId).update(update);
  }).catch(()=>{});
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
    { key:'battery', title:t('match_track_battery'), desc:t('match_track_battery_desc') }
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
