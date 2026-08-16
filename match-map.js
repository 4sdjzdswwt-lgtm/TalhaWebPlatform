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
  // ÖNEMLİ DÜZELTME: eskiden canvas.clientWidth/clientHeight kullanılıyordu.
  // Bu overlay tam ekran (position:fixed;inset:0) olsa da, iOS Safari'de
  // adres çubuğu/araç çubuğu ilk açılışta hâlâ genişken canvas boyutu KÜÇÜK
  // yakalanabiliyordu; araç çubuğu sonradan küçülüp gerçek görünür alan
  // büyüyünce CSS kutusu tam ekrana yayılıyor ama canvas'ın kendi RASTER
  // çözünürlüğü (width/height attribute'ları) eski küçük haliyle kalıp
  // yağmur/kar sadece üstteki dar bir şeritte görünüyordu. Artık boyutu,
  // her zaman tam ekran olan overlay elemanının GERÇEK ölçülerinden
  // (getBoundingClientRect) alıyoruz ve olası geç layout değişikliklerini
  // yakalamak için bir sonraki frame'de tekrar ölçüyoruz.
  const overlay = document.getElementById('matchMapOverlay');
  const resize = ()=>{
    const rect = overlay ? overlay.getBoundingClientRect() : null;
    const w = (rect && rect.width) || window.innerWidth;
    const h = (rect && rect.height) || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
  };
  resize();
  requestAnimationFrame(resize); // layout bir kare sonra kesinleşmiş olabilir — tekrar ölç
  matchWeatherFxState.resizeHandler = resize;
  window.addEventListener('resize', resize);
  // iOS Safari'de adres çubuğu açılıp/kapanınca genelde SADECE visualViewport
  // 'resize' olayı tetiklenir, window 'resize' her zaman tetiklenmeyebilir —
  // bu yüzden onu da dinliyoruz (destekleniyorsa).
  if(window.visualViewport) window.visualViewport.addEventListener('resize', resize);

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
  if(matchWeatherFxState.resizeHandler){
    window.removeEventListener('resize', matchWeatherFxState.resizeHandler);
    if(window.visualViewport) window.visualViewport.removeEventListener('resize', matchWeatherFxState.resizeHandler);
  }
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
const MATCH_DOT_IMAGE_SIZE = 56; // px, retina netliği için (ekranda daha küçük gösterilecek) — 3D top efekti için biraz büyütüldü
const MATCH_DOT_DISPLAY_SIZE = 22; // ekranda görünecek gerçek piksel boyutu
let matchDotImagesReady = false;

function matchDotImageIdFor(hexColor){
  return 'matchdot-' + hexColor.replace('#', '');
}
/* Hex rengi verilen miktarda (yüzde, -100..100) açar/koyulaştırır — 3D küre
   efekti için üstte açık, altta koyu ton üretmede kullanılıyor (gerçek
   fotoğraf yüklenene kadar geçici yer tutucu render için hâlâ lazım). */
function matchShadeColor(hex, percent){
  hex = hex.replace('#', '');
  if(hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  let r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
  const amt = Math.round(2.55 * percent);
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ============================================================
   KONUM NOKTALARI — GERÇEK 3D TOP FOTOĞRAFLARI (beyaz/kırmızı/mavi)
   ------------------------------------------------------------
   Kullanıcının gönderdiği gerçek fotoğraflar kullanılıyor. Öncelik sırası:
   1) ÖNCE gerçek dosyayı dene (ör. sunucuya "dot-white.png" olarak
      yüklenmişse oradan çeker — daha hafif, tarayıcı önbelleğe alabilir).
   2) Dosya bulunamazsa (404 / henüz sunucuya yüklenmemiş) OTOMATİK olarak
      koda gömülü base64 versiyona düşer — yani harici dosyaya hiç ihtiyaç
      olmadan da her zaman çalışır.
   Fotoğraf yüklenene kadarki milisaniyelerde boş kalmasın diye eski
   programatik gradyan/highlight çizimi GEÇİCİ yer tutucu olarak korunuyor. */
const MATCH_DOT_BALL_SRC = {
  white: { file: 'dot-white.png', base64: 'data:image/png;base64,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' },
  red:   { file: 'dot-red.png',   base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQQAAAEECAYAAADOCEoKAAD1bElEQVR4nOz9d7xtW3bXB37HnGuHE294+dULlXOSqlRKJQlKpYCFULJQKAmVJIQi2I2hAdPo3lfwMW7iB5u2DRgjk9Q0mPABG3BQt+kGGwMGSQhJlcOr9+qlG07YYa05x+g/Zlhz73PuCxVUQXe+z3n3nL3XmmuuteZIv5Hg9rg9bo/b4/a4PW6P2+P2uD1uj9vj9rg9bo/b4/a4PW6P2+MFDPlsL+D2+KyO896//Zqv4vb4nBm3GcIX1hADrl65IgBXzzvi6lUD8CK3JPwIglk5/sweuQpcvXrVECkb6DYT+QIZtxnC5+EwkKtXrsjV5jP/nkfU7JOizLIHPimiFkDNpGUcV4GrjzxicptRfN6N2wzhc3/IlZb4r141uZV0f/jh+de84Q37r9vZufjAdHrpctfdcdH7O/Yl3rE3kTu8sTfHdjtxO6LMvbiJE+tERUQVDDWToMgQxa2D2FL9ZLH2/uZJCNdOBrv2tK2f/kTfP/XB4ejaP7j++M3r//O/OgXCectxIsSf/mkHiUk88sgjxm0m8Tk9bjOEz70xMoCrV82J2BkK+pqv2f/xF91x94tnswdfMpu94j6mrzjAHtwTHtgR7nWq+y7Y7iTqzkTjdOaMqZdEiQZiAqppLs1qRVEvPJiLiHgQBzIB19FHZRmVJWGt2EJwp73KtVPHJ04799iR00efGfT9j/XrD/3CzdNH/9L73/8Uv/qrx9tLt1abuK1FfM6N2wzhc2AYCNnud488opsU8vD8B7/pLfe//e4Lr3p4Mnnj3c5efXGIr55aeEAlXNwTv38oHqKmn0HRoWfQHjdE6AcsRlXMDAcIqCW+YEY0Q1xmFiIIhsMsHQEigHNi4gUREdfhvaMTTyceug6mHXHiuElkQE6M7sbK3GM34f1Por/66DD8259f3PjlP/PBRz/KL/zC6ca9ZwZxldsaxOfCuM0QPjujagH+PY/oJgd4+ewnv/UVD3/FXQdf/JDrvuS+yc4XHUReNh/07kNxc4YB1gOsehgG4tBbNNWAiqnSBUCjDD7iouKjYmoiSEIco2CiqCkxWx4RwAmK4aIwM4cJ6Tgx1IGJQxBzJqgTzGE48IAguG4Cfub8ZMpkOkEmHUwmLLuOa6IhmjwVcR9+2nX/9ink59+/WP3r//KDj//qr/yL/+WZ+lBo8Ijb2sNnZdxmCL92Y2QCjzxSFHYA3vnOd97/vXfd9eaH5u7L73PuKy4qr9yHBw69QN9DGLD1mmG1Ug1KDIqoIVHFqwlhwIgYMan+UXHqksZgRlTDNLkgfBRwkUgAKbqAgSQtoTIOSJ8jmHMoHieCMyV4YegEdQ4nDi8e5zw4b3hBvZhzghOPuAl0nZtNpvj5FN3ZYe06Fmo3Tjv/4acm3S8+ZvFf/Pz1J//ZT/9//umv8tRTJ+W52G3m8Gs+bjOEz+yoTGDLFOj+wLu+85VffmHnq+53k99wZ+TNF9f9Sy/YMCUEWEV0EYmDqmqAOIAFsTiIhgFCRKIiKrioOFVEFdXMEMwwtfx3JJoChpghqqAOs0T8lunMCobgAGKCFbDENMQj4kAEdYa5ZFg48ZhzWNch3mNeMQfSeZzrcOZwTBDpLHaOOBPDO8R7mc1n0u3sYvNd1p3n1IYnj3z3q09G/vmHT9b/v5996hP/8r//uZ/7eHlgt5nDr824zRA+A6NgAv4971EdIcHJe77/u1//pbs7v+HBrvv6y2pvuhO5zw89rFfo6YK4XCthwGJANYoEEwmGxAEZYmYEEVMFS/9aVLDEEERBQ0yqd0xMIH2fXrOZpfACITENDM1/myYW4MQhGVvI95LQB+dQFBEy5iDgXP4RnPPEThJzcA7zHpwH1+G8xzqHeYc4B51HnTfpOpNuwmQ2k+nuVNx8hk2nHKn0N03e/wmVf/5Y5H/+a9c+9E/+zj/6Xx+tz/fKFXeV25jDZ2LcZgifxnElb1R55JFqEfyB73zXa7/+rv1vuG/WfeOFsHjrXTZc9n2Ek4G4iOZXK4tDj8ZBiEHcEJAhQIxE7VENSDScGjJELCYNQOKAWUBVUTUUB3gMwcQRp1Nc53He04nDew9ZootLRI2AkvkDYxCDZbMjMZyIhZiuEwI2DGhQTGMCJ7NZIggmEfMumRjeQWYA3nVI57FJl7AF76Fz4Du8nyITT5g6YzKxOPHI1LvdnR1m0wOOVXii63/lSbOf++Caf/gHn77+zx79H//Ha5CUmXjlipPbjOHTNm4zhE/DOMMI3vLOC3/rTS/9jS/f59+/0/OO+9Td51YrODomLpem67URgrioIusAMWAhIjHgQsTCAKpoGEgmA1iMoGAmifi8wyYd1nn8dIabz2EywyYTnHeIT8chgpmm3xHMbGQA6RMKqpk0CAPRjCUYLmMPxS0ZsTRfVHSI6NCjMTCse8LQoyEQ+j7dD+lcIZkRdB6cYBMPEw+zCW46w3wHfoL3M/ATdCqmEzOZTugmU3cwP0Tmc572DNec/ZvHTf+Hf7rs//5P//W/+X+SGYFdueJumxOf+rjNED6FceXKFXe1CRT6vm/+5pf8tofu/Y6Xefn3L5t9yUUVx9EJ8XShtlwZQ3AuDsLQ46JhQ2DNGmJg1kekD5ClcSQiAcQc2nXodILNZ/j5HJlPYTbH+RkigkjSGkCSVDcDGyAqJXzREEo4siuEn0nHkUyGRFkRkfR9MneSGQGGmUPFYaY4HCLgXNIOVDWZHabEMBCGAV0HbLUirgdY9xADEUM7QTqPeI+Ix3UdTKcw2wWfNBsmECcOnc+QbqaumzLdmbn57pRhd8rTzj/95Mr+4S+vTv/G9//rX/gnJeahMSeU2+MFj9sM4YUPsStXpI0Y/L9857e84TvuvPddL+km33G/t5ezPsVu3iSc9ip9FBkWQh9hiKABDT1OBywOYIL1EbeOSSsA4qSD2QT293G7u/jpLKnaziMiKICCBE0BRhbB0r+iSZOQbFoUJmCVPASVrGEXWWrlAEkTq1JEraVPUkwCDh8TQ1AUFXDOEYvPxIpWYhs7S1WxvkdXK7QfCPlfixFnLh3fKWE6QydTJpMJ3WyKzjqG2QTXTfHdBNdNjW5qMp0y39txk705T4oNT4n7p49G+dn//LFP/P1//I//8eNwmzF8suM2Q3j+Q2wLKPyj3/u9b3nHhd13P+jlO++b+Hs4XcD1I9XVGhd6GYZebBiYDAPWD9gQUR0S+q85TqB3mOuI82nSAPZ3kd1d/HSa/P9FXVdLrkYFyXZ7YgIGYpiGRKimiBk+jBoBRSPIr1tJgGINgM6AomQeoWaISAYeKWFKY9JDsjmw6rZMw1s6NmApfqEsQXKsgvOIGWhAQkT7nvViTRh6hmGJi9CZ4L1gE4fNJrjpHDftYL6LTecJe5iATGfGZM8m8x23sz9ntTvn42a/8P4h/uW/9fSN/+6//Xt/78Pp1k2uXr0qtxnD8xu3GcLzGHblimsZwZ9493d9xTt2Dt/9kHT//h2eS5weo8fHqn2PDStHP+D7Adf3WRIGXB+RkEA6NVDnkPkU3d/H7+8hu7sw6TAEF4GQCccUXIouLOHGltVzAUSzFpA1gxKKbDaQkxOyB0EqUYtpdjRYDmW2jC1IZgAJd0jXMlzOalRT1BVNIrksBZe0AoPoMquxxHQgmTyYJaAzaw8i6ZZSGGS6RlwPcLrGVkv6YUkQZeI6JuYJE8Ht7MB0AtMO5jOYTWE6Rb03P9uxbr4rs8MdGeYznqF773uD/pX/7umnf/bP/92/+4HyDrn6iOVwi9vjFuM2Q3iWsY0R/Kl3veurvurSzo+8DPnWS+oOOF0Qlicqq5W4vhcd1ljfI/2A7wP0EY0BjT0ScozAbAYHB9iFC8jeLn4yHSV4sfdjJliNSSOApA1k1F8AVRtzElSz5I0pGInENLIgR2PDACBjBEoKN0wMAUuqPZICnBOGQCb6EYZMEl/yPJKZDSAQJR+f5x0dl2TvRzq1xDiIc/lJp5BqJ5K8GnEgLBYMpwsYIurIWIngug6Zz7DdOW53F5tNkMkEmUyR6VTdbCY7Fy7IcHjAYyIf+NV++Jm/9vgTf/VvFI3htlfiWcdthnDOKHEExWvwx9/1ri955+HFH3t45n7rJT3d5+YNhuWgsg7SrZbCqseCosOADWskDhBCAvWionTI7hwOd/EH+7idHQyHqCQCKQBfDRzKDEItaQiq1WygxBeU46AGHGkYMkCoiVlkgiZrE4UhWPEUAKZSCds0mR+jKSIJWCy7RATNpRLKunXzuSWiB6LReDmKqyFzAwGV8j2YE2JRXzLxewGiElY94eSEuFoRh4AXh8uuy246w+3vYXs7hEmHzTpkOkOmO+rnM/YPL7thb5/H3Pq9H+jXP/Mz7/voX/6bOdgpM4bbZsTWuM0Qtka7UX7/t37XK7/9gUs/9bKpfN9l3CW7eYOwuKlxvRZZI5NVj1ueYv0A0ZB+gGHANDI4I3TQ7e7h9++AnRnM54AgUXEly9BneRm14gSV+FWzZtD+PRKsWYo+bIOTgMQoyjzQYAg5OlGT2q6qtPiiZLekWayE20APiAiBlPMgSMYa8iXL8zPFZNxWVkyV9rPye2YSJblKVTHvErNwKTLSI0wsEvqe1XLJsFgQ+0CHMPEd6j02n8P+HNmZ4WYzZDLDT+cwn6ruzeXw4JIMu7t8uIu/9Auni//sXf/r//6z/OqvHjuBP/TTV9xtfGEctxlCHleuXHF/OOMEb3jD2y/96a98/Q+97qD7XfeKPcTxgv7kVFkspVusxS17WA0wrCGs0bhOEYJBQQWbTeFgF3e4h9uZg5ukigGWsw3FMAuYRpxz1RwgpsAjwdK/xY6PKSzZwQZzkAQWVOIXs2wqSHYwFGyAzBSKeWDVFCjaSWEY6dBRk8hpDilWQSSbBSWYiQY1LG7KxnmR1fzyoVVNw9UoiAI4CgbOETHEe1Tzd0JKwnKCOCBEwnLN+vSU2Pd4S54Om3jcdMJkfx+3M8d2ZuhsymS6Q+f3dTjcY3LHjlvPpjwe/c/90+s3/thP/JW/8o/hthnRjtsMIXsPilbw3/zE93/L2/f3f98rZPrlrHuGo9PI8amb9AthtYblGluuYBhQXRNjj/QBMU+cz5CDA7r9A2Q6R1yHWUQYUFxKMNIU7KMuEiVlJ1atIMYMCqZUZishxVkrEBuPNdX8uyZiq9oDVeIDlfgp8xQgrzCGCiYWr4OgOfeh8ojMEAoTqJ9nCECtmTt7HRL0mLUDJ1h2TYhIoyFIxRoSrxTUSIlSSMUNYsEpnCDeJUAyKkO/Zlgs6BeneBG8S7ENujOHwz1kb850MqObzIjzHWy2pzt7h2730gFPTjl9f9//tf/qYx/643/17/+P7xfgp6/c1hZ+XTOEK1euuD+cMw+/85u/7iX/0ctf+h+/aj79gYvr9YRrx8pCYehd7I9x6wWse3Td49Y9ul5hZkTAdzPc7j5yuI/uzFDX4RD8kEhjkFRQyGJM0X85FJmiDZBV92oupLDhdBIZOEyks2lSZJdfYx4kXKBwBat4hGH4TKBaOEahbslnWgpkKkwiTd3gDw0BV5dk9kC0GkZUzWbAyFE2TQfBis9TBM2AZNEWKGCjJI3KW4E1HeIERRPW4AUH9KsVq5NTdL3GA+ZzINf+DHc4ZTbZI053kNkuu9Nd3Gyq7tK+6w53eFR4788vhj/+HX/+L/4VYP3rXVv4dcsQWqzgZ3/4+7/3qy9c+On7u8mruHlEPD5W6U9d7JfIsETWPbIIsI5Yn3INTA2dTHD7h7jDPZh1iLgcN6CIKWbZBFCXPAA1gCi741Qgee0Ryyi/Fbs+E3/VEFpGAEmCW2UALTCJgStaAeTYBEYib6DAkY6LSTEStzY0UbQAy8TaMgAkR0hmDSAWhlRAQxIj0KyBGLaBM+QpstchBU5ZBjTFO8wLYoLgKgMxZwQU5xwTNwGMsFwyHJ1g64AXj3aeMBWmu/t0B3vojoedKTLfRab7Nt3Ztb3LF93xfMc+pvHv/p2nn/gjj/y1/9f/+etZW/h1xxCMZGCLiH3Lt3zLg3/g4bt++rVu+u6DQBduPK2sB3Grtch6ia2X2LDE+iVuFbEBTB24DtndwV04xHbnmaBLXICiMRO/GBZSFqJkAjfNfsSsCYgmaamkhCEXBWeSdGgNpPIlbmQGNhJ6uqEGMIya5ZpW6TziBmSTwDAZp3CjcnFLHCHxAq0aQdEaWhOhajRpJcmtKVJNFKVgGvl2CkCQPQ/FAdGCjKlIC6grJkbGYFwu4FJOzD+dT4FPw+mS1fEpFjWZF51D5hP8wR5ufxdmO0zmO8h0gtvZVzk8lP1LF+Qp+Pi/OF3+p9/yF/7Cfw2sfj1qC7+uGMKVK1fce3Jdgv/2t7/7W96xN//DD0x4Q7x+SjhdqO+XjmWPLHtktUbWS+jXWOwhGNE5bHcPf3iA7MxT3cEssRNwF7O6Hyvop5kIvJJ9calSkZpCiHTZELfsfUi0a6hoAsxqjkGDD2jRMhq3o5FckqKVSNNpY0SilCQmyaZAkwp0HjMov1vDdKI0YGQ5Jq/Pts4dAcdiahgtdSlNPIOkuARVqx4GoPJCq4FMDsuZmiCpNoPLkU6FMYhAUFanp6wWp8mb6T14j9vZZXp4gNudwdQzn+wz7O3TH0710t6ei/NDPhD4W//1xz74h/7sP/gHv2JmksvN/7pgCr9uGEI1EV71qoN/8g2/8Q+8cd797gvr5Sxeu6m2GsSfroX1Cu3XsFzCeg1DqkMggE6nyME+crhHnE2IBl20hBNYto8zI0hmQVOPAMWk2PskE0ImqHNgA15BQhLhQQLYkGogmAd8jgskz1WUgOymzCp+qYeA6BmClkZLSEsYmcRojWQtQ0Zib/+tDCG7GtuQZYrmUf5v48cjHpHBzOY4zbhE8UQUL8SoPbhGc0j/M1cCnBwmIzNQSdoLAo4UP4nAMAT6k1NsucKLw6Ye5jP8wS5yuMOe24fZLotLE2zm9GC6Jxcu3i0fnLhf+acnR4/8tr/w3/4NwH69xC38emAI1YvwB77zO1/7PQ/e/SdfP+Mb5fpN+qO1ympw3ekJ1q+QZY+tFrBaIiEk6e473M4uXDxEJlMgb1iK7R4bKZ3zDShS2lLwkXnMGdFF1GkqLWYd3nzyQmStIkUHKkTDxTynI+MQhclkYsxawjbWIDwHQ8j2fvt9ClXODIFNiQ8Z2yifbTCCRNDl+6Lm1+9ogMWi3VBYRwYWq1tyBCnrMy7mhhu36cgQSpGWVOIN56qnogZaieB8h1OlPzmlXy7AIt10gnpBDnbY3TlE5nus96a43Ql+PifszfXypXvdopuufjks/vyVX/rgf/JzP/dzT/x6MCG+oBlCayL8pR/6gW/9uks7f+JFvnuZXjtSPT4SWa3EFgHtT5D1KZwGZN3jQwCDOO2Qixdw+3sE71JSXpBKfCZGdIlYXSZWaaWqCLgOkyl0gLOs2TqCE4auI0zndKrIyRGTGJJLMnRY9HjtEe2TOzJqDVOuOQ2WYxCyyzF5KrZaJFT8wDa2sW4whdKoqcQsjJK+1Q5qXEPWIjTHPFA0hkrbVgm81TggoxtlKVIiELZMlAaINHJIdIMV4F31hjhJrsaiJUhmDGqlaIvHBLwX4jCwPjlG+oGJOKI33HxOd+ECbu+A6WyGzOaE3Slxf0/3dg/d7MIh73P2//3vn7n2+3//z/zVf/aFbkJ8wTKEUcV7eP6//Ng3/N637HS//0K0XY5Oo65OPKen6OoEW5/iT1dwMqTkHU35/36+gxzswc6MQQRRxVvyp4taJvzs+y8uPkhPNJcnN+/AgXpDZ3NCt4PM9nEHl7C770AvXqA7uIQn0D/5MfRDH2T6+FN0IRCcwqC4PkAYcMFSOHQIVFEbNRF2CVQykjdji8C2TYaq/seIcwn9L1vcnpVx2BmmAIwSmUjGbNO52IbGUSR+LICjjRGOjvK7UZyx5TqlKrQ5QTXFNYhzOS27AI0pRsFEwJe1pZgHzaaF84JTJSyWhMUy1ZFwKRR6snfA5PACOt/BdmawN8fN5zab7dnOXZfd47uTx/758Y0r3/2f/8W/KGBfqF6IL0iGUJjBV33DN9z3p1/94J9608R9d3cciMdrZXXDuX6BLHr0dI2uFshyhY+JkMJ0iuwfIHu7mPM4IwOEKdSm2NsiUhOKzBWgS1IwUjfJ1Yw66DrCzpx49124Bx6ku+deusNLyP4udC57IhUXAnrtGvGDHyJ8+L3IM0/SrQd8NGw9IMOAhABDTGZKiLghmwc1chHQmCV3gwsUhqCclcZFAyhMAaHVCiCHOGfToP13G2sATd4F3OjOLGZF9lIkAHFMsa4xEfnYXDA+aQBbbs8KLEoqE5crtCRwUgTnS/n4rLW4UvvBIeIQ5xPG6YQ4BPqbp8TY003TvN3uAf7iBWx3jsxnzOa7uPku/d5M9+7Yd+udg/UvLOKffuc//Id/lPe//+gLEVf4gmMI5SX9nu/+jjf+yH13/RevnNpXxmduWlxEWB3L5PQUWaxhtSQu1tADMYCLyHyKO7gA8zmB5Pd2JZMQSOIekB6TIUvVGeYmKX9/6rFph/MzdL7P6tIF/AMvYnL/w7i7L+MO9xKQGCNimbCj4gJIEMyTPBrPPIN97HH6D38Ann6K6ekav15CWCdJPOTqShpSMdWouDDGLyibUYyQ4wt0MwKxELdlAodySjEXqIBhPS8TeHKfbjKFFEqtWU9I4cmF8JPbMh/LqFDVYKQGqNSStOVqKCQldkHz55UKXWIOIikHAgdaTIvMECRXiK4MxIHzDtcby8UJ/XrBRATpOmw+YXbhALe3i5vtwd4+ttfRTae6e3jZ6Z138t6h/9t/5ld/6ff81b//P33oC40pfCExhAoe/qXv+oGv/dp7D/7LB318BU9fj3a69DqcwmqFO+3R5QI7PcWFmBuUONzuLnKwh0yTB8GbrxRhpE1mZqkxSQzgIXYd2s3oXOpe1O/MkP0D7I474cUvwT/0EN3hBZjOc2BSnk1jAv9ywRM0mwM6JIqMEaKhR9fpP/pR5IMfwT/xFLI8SdeOCkNAhgGNMcU6FMagVtOmRySvgI4pvbkkM9YHBw0wOGIHBSUsm6Q1H8rfG0lLFkdwsGEIIxvIoU5NFWiRxlTJzggzGTUC0vMxAfGOkGKbR61GUuOYVC6e0bSAVBo+A5jO+arFFRzCMDqE4XRFv1hW887NPbP9Q/zBIXFnB7+zy2x3B3ZmxuE+B3fdLR+K9n/87Ac/8hN/+G/+zX/1hcQUvlAYguTNZX/jB9/1PV9/cMd/djH2d66Obsb58dqzPMGGm+hqiS4DerJgEhQRR+w87vAAtztP0iPbrJ01DUtySmDMATUdM4QZNvOEOQy7E+zgEHffg7iXvoLugQeQvb0UYBMjLqP4JaGIGMFCU8uA3FQloiEkjGIYEtXGnuHmNcLHPo57/0fonn4GtMeGAb8ckD5gJdXakmbgcsXktP6YgceRIWAuaQatZ6EQJ5tAIkrOjjzfHamaogU1x12YFIYiYwYkmVlgJBft2XDn8bgMKmrGINrcC5diFzSHPwuJt1jJlswh0tK56vEo0Y/k2AbxiXmoQHTgnaPDEVZrlscnODHEg3UOf3CB6cWLMJvRzWd0u7vY7i5+d08v3H2ne9TL+/7RY9f+g5/4y3/pH36heCA+7xmCMUYe/v0f/W0/9dW7O//pYQx762s31K0Gx2KNOz7BrW4STxdoH+kyHshkijs8gL0d1HucaaIbkVT2vKjHUjIIZ6ifYjOPTEFnUzi4QHjgQdyrXsnkgQeR3QtgHtGAujUqilNJKm0hdtWkMWRNofRlNDM0xtKVCekjphElIKHHrl8jfuDD8JGP4U5OcH3KunRDauuWSqcnl6SrSVCJEItr0sjBTy2RF8IsGgxUbCJpD83z3sIXNolaGw2jECmZRGJS+xMSWM/YZjTj71JjN0aEIgl3FUFNcFsRjVUzcU1SlUt2hDiXtQmqlhAz43CSirNIiKyPjyFGnIfgPO7wkNnFQ9xsgpvv0O0fwM4cPZjr5ct3u2f87BP/6KmnfucP/6W/9LfMTDID+7xlCt1newGfyjAQL2IqIv/oJ3/wD37F7s7VvVXf9c8c6XS5dHF5Qlgt8Ys1crTCDYEOGASYzekO92E2Tz0NEpSNE6vlyfJuAecx59Fuhs5m2Myh+zOG++5n9po3sPPQy2B3v0HTI+YUEZ9dXyl9OQF7RStIAJzlrkuUmgbFcBdDvSIh4AeADju8jH/tHLt8J+HDH2H9xGN0tsShqCgaDT9kZuByNaOcfFTUccnaSqvq11FcAk3+REP6lPTGMx6GihMkyhQh1Y3EcIzaUfXV2VmNo9UYRu0kvwcntQJ0mj+Vdavu0lJizmUnZsx1GkySUiQJ/9D8mfh0Hz5XYzIRoveId0wPDlifnqBDz8Qc/fEpixjYuXxIFCWK4MXA424M1/XS3Rfu/U33XfyvfvaHfmBHRP5KZgrVufL5Nj5vGUJiBpiadf/kd/3of/JFe/ye3ZNTCdeCdYvByekStz5hulggN1cES8VMUUXmM9zhPjpNXYawVJqcjE4D6fcutSnTziPTKW42wWYT4l13Y699HfPXvJZu53K2dXsEIzhjEPDqmfRTXAhEv6qagVNyTEGsrkuLufOSWULp83dRAnGqdAK+t6S+ywTuuQe5uId9dAd7/2Pw5LXUtKRzDKyZAARyPQKXcyvaBCc7Q4zJBWjVhJH8DGxEFskZCVsaAoxApdTPEpPInsbizaA9Ziu+oX23ec6yjpi9JjWdGqqmU4DeMfZBQVzqJKUxNaTJpps5yWBnAkRTaxtHcImJqEvmx+zwgOHklH65RnDE0wVLicy4mN3Owjw4bBd3/aleD++4cMfX3n/Xn/3rP/479kTkv/p8ZgqflwzBkqff1F4++99+59f9iS/e9T/lb55aPFpatzoVOV3A8Skae+x4iQ+GepcQ/vmMyf5eaidWRaKN8fHZLZX82R6dTmFnStjdQ3cO4GUvYfKmN+HuvR9RnyRPZ8kfruDVkJBBQ4tA6rwkMQN/uQxa6p+QgMYCCKbJQgYgDWek3gypt3PayNlhL92c2YMvxc0OCfMPo594gm69Qjsh2EBnAWcZZXdSxOO56n4lQEgaRQEGt8yD7fPO7vnxGqlXhCRtAJJ1b0lDAUYtjEToJbMyAZdZ66ApvwbUwq95zeYy2DDGPKcYBSx1marrjSlAzMil59LaY8miVAFJZedMUiCU398jOk88XdKZQ0+XLIfA7qU7kOjoLeLZQUTdEaKHJoe/4a5Lf/Jv/M7f4UXk//H5yhQ+7xhCNRPMZv/sd33tn37b/uzH3TNHGo+X4hcLsdURslikPgA3T/AhOcG6oNj+Lu5gD+vSHnKSA2AcKblGHOZ8cmN5j0wnyO6cfneX4cGHmb7+jUxe9ipkvgc6YD4Rauq03CVk33LUogWwHsSQKCkPoTAEjRlHSIFQopaLoyhiOVMyRlyAUknZSD0Xauu0KEicEO+8jO1P0YMdwgcfZXJ0gnhBYyqF7sVnbEAxnwDHkntRhnNSXX2cwwDqs7cxWKiMEmloVhCD9J2IqyZH0kpcNhXaS9jo3ZAxYrHkL7RmQgo1yBGSUVObuKKJUO4nHasa8/VJ5oP3ufFtAiRdDoWu90zKsHTiEijqU4Xoye4OziAsljgxsIH1MzeSF0d2EUnp2VPELXvRC2q7X3Vx9n//6z/52+Pnq6bwecUQGmYw+d9+6qf+5Jfu+B+P16+rngTpFguJq5uwXBFXK/TmTSYhbf7oPbK7h9/bB+8YupR/kG7eYV3qTJQA+AnMdqATdGfO+u47sVe9mp03vZnu4uUkR11MLi1zOFNMFCPibZT8LlqCsS1VSnYFSDTDNOTuzYq3wihCJvSkIZQKSJKJuQQWFfXYnIFPOQ9M5/iXvpQ4mbN+3weYHh0lMNIMVhFvWUaLZi3DU5omCOTIS5IXpNEQtsd2GDIkqb0R5QggOZqaBNbVJKYtDSWVZDdG9JEatJTCkseoxxKLUJrLao6DgOySLFpCLkKrUphRSvpyMkY2GimcGVVwluotaIoqleziNEv9Mv18hmL0qxVOhNCv0WvKNIJYwog0gM2jO3p6pfvu4t5XXbj4x/7yj/7oICJ/MXsf8vb93B+fN14GG70J/n/7qf/wj79tZ/ofcvyk9qtTmRz34o9PYXmMHZ8Sjo+RENLGdg7Z28ftH2CTDny5aYdIl4JdOof4CeBhR7C9jjjfZXnfw0zf8jZ2XvxKmHnIxKQuEYYzUlJSDCmiMIRcDyEkTCKmmALV9Hnq3Jw1gVjiDUp+Qi6eEppCKtESIeRCq1LLpMWE1iupvHuIidBjj378cfS9H6C7eQ1WqcKTacQPuR+jgZJayBfbvqRFR7GNDMrzzYsWe0gqu9Xj87FZC0geh7H6krXn5wrPY6Tk6DEoCVPZP9DEMqTvIw0mUYHKhJeY5QYxlLiEvC7nUFzNihSX6keZE8wLPrsnxbsmc1JwLpVsW69WLBdLJt4lRtVN6C4dMjk8YDLfYbq7i+7NYHeuFy7d6a4f7t78nx6//hM/9DM/89c/n+IUPl8YQokz4Od+8icf+Zr9nT/kbt7UfnksLE9kevMEO11gizVy/QiGHnUQHPjdXfzBIdpNiBOHiDKJHuiStPEOvMBkStzZRfYmrHfm6GtezeytX0p38T4sepgmaULpVlTUe83qvSo2hFzToBB7ciFqHKpGYDHkwCFNxJyLq1I8EDGO+QilHVuOGZCSyITlRi6COk3FXaMSdKALPfL00/QffD/u8afoVj1BU/NV34MLEAmU6KRSSyFqTESQ3a0t8UK2341KrJCJtZR7y9GISROBgiVYBTKTxlATsmiYSAEeqaFLObEpF5VhDHeGlIJtluomJOajCSws68MwkiYRLVKLuopkkzD9LjlAKWI4l/92pepzOs55T0Tx4hhWK4blimkOVQ+TCfMLh8z29/E7u3Cwg9ubM53Pdefui+7G3qWn/9Enjn7kt/83f/7vfr4whc8HkyFFIIroP/rJn/w9b708+YPx5LoNq5XoepDJ8RIWRwyrBXZzxWwIafMAfmcHv7eXCmMUbwKJGcSJY5ga4iJuOkV2JrjZFL1wH/7Nb2b2ptche3toUGRKio4jJTaV5qi1NHp2GxZcQLBkx+aW6aJx1Ai0/GhlACX1WbJJkdGv7I7MUramIDdBR5biDNQZTpVJDvrROy7g/cuI1hEffRzfB4JXok9h0o5MVKqpbkClSih/Ji2/xCmM7soaXGU5VZsioYuGsMVMLDOTBiNIxDwGJ40do3IJ90LwjJpGWWL1irRrK6ZD/r14IWKEml6dP0s8KzevdQXvSMzG50a25kewMhJRn5jddDZDojEslzifrrK6cRMBJiK4DnCwRt36mtfD6e6dX3f/5f/yP/u+dx/JI4/83OcDU3DPfchnd5Rw5L/9Iz/0Q192R/dH9pcLZ0dLulWQ6fEKf7ogLJfo0QnTEFBnDE5Sf8S9feiSa1HIYcfmQRyxS94BN+nwO7vEC5c4eegh+A1fw/RL3obsHxJcIOxkGxPDZWlKiEiM1XNQ6hlUBhFzC7Y4agrEFJko5Se2zCDhDFZqHtQ0ZxsjDLM7knxNJRIl4IcBF3qUABZyDoND9g6ZvOzFxHvvRv2Mjg7xEN2Qch2yhByBPGnavkEF/DIyX8OWS8BTY1IUkFHGU+vn43HZ9CEDi5rhxsa1WVrQjy+/CY1omQnZIVSZYjZ1SEzOchaoE2oOh1W3q2W3bnq+5b7ScSODL120zQzLQWNRjcnOnG5nzlojIQR0GFgeHzMsTgmnS+Jiha4ierp215+8pnf3/b3f9MBdf/b3ffd3fJE88ojalSuf0zT3Oa0hFI76F77v3d/8G+/Z/1OH/Xqm13udHveOoyNYnqDLY7h+XDseBXGwM6Pb30sZh5Iq9UKykZ1LpofrPDMv+Ok+ce9Ohpe8jNlXfBn+7nswE8wlH7aPo++6BONqUfk11s1TvAQp2zBHIWrEYrLxWw9DbbkW88a0NmjJsrZRNIUcHkzamGKFQeTNbTHhFWSpDjgFi4btzJm89CGiKvr4E3g1Bh9TrFW0KmVr4BA5iaip2Vhcfen3rfiFc4KLsrqQnpONWZFaEpTMsKLCOSgqiWXgMT3fkUhdzo402CjsIttra35JWgyUFvcp7Dl5Kixq9li4Wp1ak5qRtKXscUiVowF19b7MCwHwuzs4jcS+x6HE1ZrTmzfZzdGQIo7039Td1Kf0RQ/e8Zrve/GD/8WTX/tN75JHHvlg9j58ToKMn7MMoTCDP/UD3/uVv+X+y3/u4hAuxGu9usXS6foUWR2hq5uEG8fM1obDEURTwYvdfcz7pOZnkMg5SRvQ+9Q4ZXeC7c7pD+5keO0b2Xnb2/D7F5LPuhNEPN3QAUrwuURZBvpqsI5pJv7samzKqFcAsPwLGQyMY3SiGhbDyAzMKkOoqnZmMla8V1nKugFACN5BCPgIoollpdDlkMKZZxPcQ/ejQYmPP4G4iGjCELYDjMwsE0Uqb+YyXgJZ2m8lN5XvapKTjURfiHsjX4IKGCRbv9gmeRTPQdU4qleiiRcxNpiQbV0neTNG86aBKJK7Ms+vue8FmtbhnMv1G1x6L46qZbhc63GwkNydOGY7e6xz814D4mrN4uZN9p0Qu8hEJnQyELy6G48P+tJ7X/RlP/ZFr/izjy6+/N1O5EkbvaufU+NzUn25kpnB7/3Od73qt95771+4W4b7wjNH6k9OnS1vossTbLXGri2YrhKBmCluMqXbOUQnU4apELskYSAXyZAJ1u3A/pxub5f+8l0MX/w2dt/+VfgLF3NQUpdVVxIK7qjqJTnAyGms7kEXFRcjEjMhh+xiDBFCQHKUoGlIfRkymGgFb6hYhI0eh6zmFjMhxSmEDEoqNmSsIRq+N3wEFSO4ZDZ4TQ3XEtE5mM7o7r0TLuxXyRobFTz/UlXwQjS10nIjwVNw0aYLsmoBYk1egVHqIhRelxPKKwZRwrTLdQpTEcvVoMnxVNjodqWYEOVPG70VpOIriYe4ygwopkX+T7HRk4DUmhcASsQsjGadKrGYc2rJo6MRE2O2t0uUFMPhIoTTFYvrN7HTgX55wmp9k7A4RY97d/rEM/r62eQ3/d/e9pY/bDDLjPBzDtT/nNMQDMS/5z369re//dKPvOz+P/uiibxm/cz1aOHU++Up7mQNJ0vizWPcKtnMQcDmU7q9XXTmYOLoBFwq4I9ktEe6KWF/wnBxBof3MHnTl+O++E3opMOLwmSSJVZG8nMFY1c2o1LNBNWQ041zQlHUaiJIIeSYJAgtWFjtVMveBmtiDiy3cktPQhrp2LZrSyr2kLa3gERSwFHVOgzL7kgfIrZYEG/eREKfy64LIc+TpGn2GjQehPoyoCL05R6SF2EEBavEbv+vo0RP7sBITa4q09sow0e35Wj+5PCJDU2mnKf5yWhhZJBBTpdK2pfr5itolvpliYXB1bVkBbJWj3Lp5jXGjfoKpUJ0EOicY763y+L0FA0B13mGxQrxJ8x9lyIhVYkmREGYenvtpTt/6G//6I//OxH5M02G5OfM+FzTEIQrV0TN/J9461uvvqJz7xyOno7dYumnx0tkuYTlAm7ewC2WeNOUxtoJbncH25kSJkliJGbQYX6CTqfY7i52MEMuzBku30t829cw+aK3pfoHEyH6SRIkkqvxqKGxyRLUEfjTGHJz1owRZKK3mFXx/H3RAsA2XYqWgMcyX4lNSB4FraBXuUZNelIjhTYnhqTa44eABEOCIIPBEIkaMB1gcYI++hi874PIo48hxyfJhy/kvAmradA1SaloR1vbtNUSCkG1DCC9vI03OZpW9chCnpuMZPPsxAXKN6ojgyjngW2JVqmnW3MdRZvrJByjukmhxjdsRDuWZ6I21o0oc5T71uRhCZZC4v1smlyduU7FcHJKf/MIOV0gufWfLVeyOjpienrSfekd+z/9Z3/4+/+9z0WQ8XNqMcWj8Pf+gx/7Ha+/MP9JPT5RTk6dLG7ijpfY6RI9voYtFnjNG9oJ3c4uMpth4vHe56g1T5g41nMY9oRh36MX5sQ77mf6xb+R3de9FZsI4gIdHqOrwSgFYXaQMIOgWBiS7V0SkYqZUAi9xB2EkUEUt2MxHyzGaja0WY8FQ7DWLRm1Qc2b8u5ZE3CWNaBgSFBUB4IMmC7xN64TH32M9Qc+jH7sY9gzT+EWp0jfQwhoyO5QqIQbY9yQ0DTEUjUDPc+70Lr1NkeG6LbAyJEZ1LZuzd9joNI4W7uu7Wtim/ND0V0ypiHZsGiwiY37yiaaaky4QsEaNGkHxfOQPC1xZKBAUCVgdLMZk9ks17dMpsby5hH98Qm6XKTI2fUKWyzk6MaTumfry++4/94/9h985295lTzyiF75HGIKnzM2TAER/8QPfs/b3/3Ai/7eHX28HJ66Yf74uoTVMf5kgd24gVy/Wf3waiC7O/j9A8x3KSR36hD14Cf0Ow6dwmQ6ww4Oiffch7zt7XSvfUvCFvyaYeoQm+JVMIm5ilHjGtTG3g9D7tAcK/G6qikMGUcI2Z2YmEZxOVZtocQrVK9EMRlKkdRM+KWJqzVYQ6wiC9VcEFZBNGD9Ajk5Jjz1JHrtBv7mChl6CD1xWKUw6QCy1ioZ1XLVJtt0v9V3UpkBFPS+Jhs1xFtrLWINI2FMZLLR5ZhwwxwHULWMTQ2gMIeMDtGaEeSYgdbfMOodI1PSzOi0MQtSLkNzf+TO0UjWnGTsCmXpHsW72vuhmE4mkkBrL5T0cm/QLxYpAKxL0axuOmHv0gW6gwP8wQFub048mOL2Lui9977Y/du+/9vf8Hf/7g8+8773Hed5Puvmw+cEZ0q4wSP6bV/3bXd/2533/LE7TC8P126oP70pth6QxYAdXUOObubmSEJEkNkMN99JL6dLpbgtvWWYTHCzCdPJFL+zj16+F/eWL2PyujcQu0ichZTaLDOiCDBUV2JrBlSPwYYLMeZgo1gJW6KmMmgZN6guycwMahOXPFdrQog1BF/yHWLxQLTfFaAxc8MYIC6x42vYxz6G/ur78R/5ON3T1+iWC9xihV/2THrDDZEYAkG0MpkCtBWAcSOOIJsoJYxZN0jwrFQuzKOo3dUkyQ1ki2RNiUXb5kIJDmpb0G3aLZs4xcaZpG2ctQKxVFildrBufmjU/nLvFnOtCjK4aLRcKpmIMWtQWvhx+j0DyRYNNZjM50QnBE1h7dr3LI6OCaslcb3C1gN+EegWK1k+dU1f4Wff+l9/w9f+ThExrlz5nBDOnwsMIeMG+N/72rt/+qWz2ZeH68fqlyeO5RpbHCOnR3BjgSyNkF+WlFLp0ynRp9Jn5h3qJZXh7hw6mSD7Bwx33oN9yZcwecNrwUdcZygdYlMmMTIJAYsuq/BWYwPI9r1pTGXK6t86BrFYMieK+mm50ImWYKTyt9mo+mdGUomo2rUlpqGsg0aDyDsxX1diwC9OiY9+nPAr78U+9GHkxnVYrpF1ZBhWKf17iDCABJcw0pwxaZnBbBN1vVYxyYp5wKZGkE5IhFH6JxR7u4J2+RgsufXO4gbjddVKzYMi81NJONtyjz7bqNpBe08b37e6xLj9KKZZMYt0ZCZawVHLr9tqAFeJJBUzgkbUO9x8lqEexSvoqmd5fMqwWKKLNbIMhGGQa+ubwvqme+vFC7/nT/7w933j5wqe8Fn3MhTc4O/81G9/9+sv7P6OeHSk7uaJ2HKJrZb442PCjWvE9ZrOHFOF6AW3twuTKeRSWtGnwBJxECZdau65t8vqjsvYF30R8zd/EdqlaD3E4S1lIjqNYA4zIZpWE6BEDEqMNWlpzFaM1SWlDU4gOUzZamRiDk6qm0erPV6lqKb4AdOx3Zua5eSjlP8suVe6Kcls6Xv0+nXi4x+H6zfpVitkGLC+h5g2rWRQM1aV37JXJEFyyTppALpqG0utZVi8CPVdWfEwULWLyhRI9n2MScqn3IJ8nxQPQjk1+QgqbgC5FoERt2MdShBBHlr5TLYfKE1oy+ebIx0xnpHmHCMrWxNIC8vQkS2l73NwmwmWI6qSh0NTaXfSHFGVbjIhDkbs+xpS3R+f0HVTOjdBPOjUIb6T6zev6Z3z7uI33XHXH/nFr//6X3KPPPIx+yzHJ3xWOdKVK1ece+QR/b+9+3vf8BUHl99zsGISjm6KrU5EFyt0eUo8OUFPVyl/wCVp62ZT2Jljna9zmQPxHu9n6HyK7u/AwWXsVa9j/kVfBJM5IhNEptm2DaiLmRwUrB997NFyAFLSCMQsgYiavAOumAA5NkCswQWqqRFGcyLkMGezjEGMm17LNULqtRBzPQQpDCYTeLRIjCvi0Q3CBz6Evff9uCeewi2W2GoNqx76ARlSu3qCwjC6Ny2GVCNBx6jBkRlYlvRWsLgNad4WZG21hFGitpKVzCTIE+VKUDnoyEqaZnlvzbylPkH92fAcsBXnMOILCTgcPzlvpODIFnsgRyzm99CYF0kj0HJI9hiNmkKJOnUlVqMxMTQqfjrBOs+Q8058NFZHx4TVgn69wBZLJidrdLl2T11/Wl/s52/54de/+fcbdNl0+KyZD59NuyVlML71rTs//86v+Gtv7Ha/lU88o7p42oXlMe7mErlxTLx2DR8Gcl1tmHb4w33idJokvXNYJ8TJBN9NodtDL06Ily+iL30js6/+KuzSISJdzo5rNk1+ucnNlkuZZdBP45AIOAzJhh+GUdXPGIGFIW+YWDMdRRWzgIYhaRu1GlIB8EYXYk2Frkh2zJpDiSeQ5DojIqdH2GOfwJ4oHoMB61MnJxlSVGI6T9AQ0+YvjEeb+AU12kSj9L0yhgEXbUSrnNqMDByZghNhI3OxEHBVgjaJy4r4s/J7Qf0zo9oi6HKtuszKIJq6DDUIKn0Zt8yFxH5S5agS9ZhAzTHGwoCYi7C0DIncFyIxIJdLt5PBxsxNCsjoUsgzkgutxMh6taQDOu/RzuN25uxcPsTv7zGbXsAuHbC6PLfL+5eRwzsX//0zT737h//cn/tbn80kqM+ayVAyGP/BT/3Eb3/VxP8WvXFNGVbilivc8SluscJuHKVWZpDKgTmP7Oxi3lO7BUhSO72kRhu6O8XtHdLf+zDdl38Jdsedabu4LQlS0PGquhcXYHEHZlBPFQtjQ9Za+zDnJ1jGDjaBwjECUQqxGaO7sSDp2YxQLGk4KriQvg/EFCzTB9xTT6GPPoq/fh1ZL4lxQIPhBzJzChV7qBp3cSsWjIKz3N8yY0q/N9TsGgm/dfwGwTbMoJxrea5tSW1WKjO1jGe09wuhJRNj1A6ADc9Amkvr+aNw3pT+lXFlk0Oyh8Gy+uLYIv7kcxiDrZpCMTU8Whu8pCzBWX52gpJcmzHnyrhJR1j3YGnmuOpZHeegJVvhTqfI3MmCI713Mt/7yksX/+D3/+Z3/h/ukUc+ap+lfIfPislQTIU/9gPf++YvOZj/vlmvLqwWsorHossBf9qjRzexxTL1GMgv280nME0JSy4HwiZXkQffEScdetCxvvM+Jl/ydvzddxFlyHeZQ1lLTH5UnJUoREVDqIRtcUgYQAhjERNLlZA0d1zCYrLEMxNw2W5Pc4SmLFoJu20CjMigJUnaJUaQPg4o0VJodHfjOva+96Lvex/uqaew1SlxGJBVpFulno8WhxQopVrV+NgClnEk1vJ9xT2aJKZaFi1Lfan8YdO1CFTTajO+wGrWYVEBSvRhOe9Mo5dyDKPKXtfApnZQ11EZSGakGXS8tWbRMJz22vln47zCqGHETyzXZGjus4DHmj0MheluHpdqKZQ6DprN0HC6pF8sCEOPLhZ0x2t0tXJPHz+j93b65h98+et+r4Hj6tXPiunw2WAIcvXqVbOXv3z2jXff+Yfuntj9/c2F2nol/vgYVktssSKeLDdSYW02gfk0qWviwVwucNFhvsOmM3R3l3DpEvKWN9G9+KWIOjo0lUQH0LzZm59iBqRswli1Awk5i1CLBI71xWsYGrQ+VzjS8adUWC6mQGE2aZNplljp9ygkpHodEzBIRIYl8okn0F95L3zko/jrN5D1Ch0G4hCxUGz2OGISZiNR2Xh/tbBJBhetgnyxqvIVDyiYgG3+pLeWz23MiFoPYYNwqdcprr2UTXjWBbhBZM0o826Xirczv+f/Nyhc+3s5wsRy+biyA89q4yN6Md6INuszK9GLzXNpvSDFRMoeHFPDe083mWagOKdUD7A6OmW9OmVYL3CLJZz2LFdLOT6+Ya/a2f3Bn3nXD/3m7HX4wmcI2VSw/+6bvvG7Xroz/y16/YbK6kS64zWz4yUsTgg3j3FBiaVRhwjsTNBJWm7NjXc+NduYTrGdHezwEH3lG5i+9jUMnYKfITrBZftU8JXgUYWSrVaDhMIYg1CQsSL1SwxCSFWUnZKjFYvHIVDCipNkHs2DgqhrLHEEOZYgGj4GIKAyIDrQHR0RP/QRwvs+AM88g1utsFWPLXqkz4lRYUDDgA5DDZAqJkypj5hCr1MBlPOyFAvjqEVOszTXsvkzMVSiNHIw1Pidk9wBqp2TRrKSbj9ZSrZ17Y0VQa5LmYhVM8OKwFnibUh7m4zrtYFSaDozn61JREeA8hyyq+hGu97ybIAYY7onI3ubxhDwZG6m6A7fdRjJVIpR03ZaRZZHRwzWs+7T+52sovTHKzvwtveWh+78j7/5He+4x73nPSm14tdw/JoyBDMT955H9N3f8l0PvuXizu/fG4bOjle40xPxp0viekk8uoEsVilslPRS3XSCm06TiudI3XecwyYeplN0PsH25sQHH2b+5i+BboaIZduvSyG+2WuwnZuQeiVYDjLKwUVaEpay+9FI0j+7H1O9xLFEWolNKJujFOQoyHsKoyK3hCMFHeVgJumz9kFAb1wj/uoHkA8+ij86xi1W0A8EjQQM+ki3DhCHlFzVqK+Zmseciyr9Y/630QIau30zXqC8Kdk4tqrSW6nG9d9M7KkpC+eYAWOYMiQGX5l6xXWKqy+ZUVa+k3LMJkXbLX7KdxUvqHd0HmVtajjGaEokiKANaywrormfja+Sm1dLtmVywYr3+MmESNISNMeuhPWa1UkyAbXvkfWAWw7u2o2bdmk++dIffcNrfrRlbr9W49deQzDkR171wO992Pxr4vUbKuvB+dMe7U8JixXxZFUJyKmB9/jdXcAj5jKKK1jnsYlHZ9NUKv3uO/Bf9hW4O+5AcHgVxHqQAORKPHEYy5yZNe7CkOIIQqygIiGMBUxLDkO+AY1jX8bqXiyBPtpoAKpATK3gVJFoxFz7nzBg2mNquOUK+9DHCL/8XuSJJ/DLFfQxeRH6ATcM+JAYR1DNsfaWK/lkpaNgLRqoFrbFBISTU7Ct1HXflP41kzJh6YwNXTjDRMpoJWI6TjJ8UIh4ZA6pg1L+G5dFclLjVVL8BZYwoeQRKJK7MIYco5Fdh0lrZGQWxQTBxnOb4ySDfbUBTb53a/pGQHJrKkaQsWpzuWtFMwg9Pq/0T4oPIRN7qmWV4j/UYIiWsmhF8n4I6d2EyHAjdSLX9Yr1+pS4OiUcneKOl7zmcP/H/shv+563iYj9WgYs/ZpdyK5ccSJif+6nfuRrXzed/iBHx2aLlbBYoUOPrAJcP0X6kAJzSFmHPrsXTdNm9ebxeEQM6ebY7h7h8E7c699K98C9qCh4n2r2ZT9xzMSUQEAbE5SwCsaNEYTJu9CGLpOLmEpMgUs1gcmMlBJtIwOoKXJQmpWUIsouksyLDC6qBuLyBv0HP4i970NMnrmODWuCrmC9REKo/Rw0pE2U0qstq69gITGHWv7MpKqyoyqfiC1RR6lRoFWNpyH6bU1iw+1XQUnd+KxqFOVdb5kddQ9s/aVbn6RxvobcSvgM7p/1mjzL760WQP37DHKAtSuQzXPaNadnrcQYKtOTXBtBtcR/jO5cP+mIlph5jCHFloTA6fEJ2vfEdU9YLdH+RJY3rusF8/f9xoce/L/ywAM7XL26sazP5Pg1YQgGwtWr9sav+7q9t188+IMXdNiPR8fm12uxfo31a/T4hG7V56paCfxz0w43m5Y+HcmrgKATwXYmyO4MP99DX/wKZq/9YszlpJkSdWaWovuM0a4rfQ9i6ZrcAIK2yQyKSZHcjxlDaHs0FkBxNJQb/TVJ7xTolN+mAx8zBmAD7qnrhF95L/qxR1NswbBG1qvUtn4YMgPIJkFsf7fMILKGkD0uaJJ69TNzaDRMM5MgPdcNotCzhJ/e2fjZtnegHlOZRoNDtHO3x22YCDoGF7UMh0RAatrENDTr2mICrcSnwQJsg4QbZrBhAWwbGmWas2xrNG8Ymea2GaPJbVzSx7Vmj6ZzXOcxLym60RJUImr0iwXDYplyTfoe7ZewXMlw49ReNJv85r/4W77xW7OW8IXDEMhA4nte+ZLf+qDjq4eTU5N1L3G9Ig4r7PiUePMoRdNlAEecw08nFVh0ziHOox2Eucdmc5inzkWTN38xHOzhcTl7LUvInDU4agaFIWSzoSmHrkOubqQFGyhBRYUpJFehxZjdfAn00oZxYJJrISYbvgS6RicJJ+h7IgNKj37iSeKvfIjZx59mslgQY08YAn4d6XojRqv5D5bTcAXGqL9iIpQNmqMPC2aQ7NlI6Z2QPmTMVSiqsjEWXG21gmYzw8gUNtyMW79XV+eW4C+yuMjjEhxWdnhiGJnIROsXFUMo859BEsbjakCSUMMPtzUDSxcbMQ6hmiIbwKKxec7G+keHZb3nkvdRNDPN3+d3YOkh47oU9mMlWSrjUMujE3SxQtc9w2rALaKsj49sN8bZW+6483d/3Zd/+d1cvWpm9hlnCp/xwCQzEyei3/Zt33bfGy/v/0cHIbp+1av0vWNY4/qeePMmrFcEl1qQdQhuMoGM0DocKY7AYOpTJqPfZZjvEN/wamYPPZCqEHceLw6J+eVZ6tpDxgtKLcMNbaHWF7CaxVjrFtS6BoZpqJGGCWnOsQllPiOXUR/dimkJIUmEEFAGiCv46GPY+z+OO11iwxoXAjJEZNDkwTQhOks9IdtNlgnVcm1AtZRVVwJ6UnMTgQabrtJdyCHbTXye5Y2uxcRpgbKzWkP5/LwOTvX77FooRJBPSib0WPSs/rutlJf1FTU8fbsl8Rmxi2QlScNcRu1m4zr5trd1nfH6Y/eIdI3RDGoZUZvLUc5Uo5azNyWXks/r1FTWTRyp63Qp7moJ9/GihPWK1fEJs3mHLgdUeuidO712YnfedfktP/rWN3+fiPypXwuG8GtlMvBTr3zpjz7Q7b5uOF6pX504CytcPyA3TuB0mcNgc8FREaTzuWFGaWfu0KnHJjO8mxN35/QPvYTpa95A7HzOCPFYSETksmswI24Z7BsjDlP2YhM0lPMPRhdkBuJKOnPM9Q0yUygRia7YomY1VqGUBIcUx+7XfZ57jX7gY/hf/giTm0fE4ZSg64Sh9AOEQLQESknGC1oNQGNuK1+qG1WmU9xe5E2pGxI9xWCUuIFRip8JFGowgm2Vv/23PW9DS6DYzDoyACmakm5K3G2Gk3RozpJsJnyhAobkWgnRSlp2ImhtSPdWmsSZz4qa1NxLKe5q55xX7qGN+bCC36hkhp6ftbUz5H3tfI4JG5+lhcji+Jh4usb3PctwBMOAniytWy/ktRcPf/x3ffu3v8KJ2Ge6mMpndPIrV644J2K/+we+/dWvmU5/x+Q4mvY9DAvCsMSOF9iNIySXLu+i0ZngJl1ulpFwgwSVW6p5MJng5jss7tzDffGb6Q7uwlkikkmfy4u3Gzi7BTUXNtXibsRGLKC46kqQz7anoJoSmr0Rmour5tBk1VHlLUQXFIZsfqDYekn8lQ/iPvhxWC2IYYlfLPGrHht6okV6UYIlLaULKYmqgn2mubGIjCZCUaNHY7XGBZw36sZtzIHzgoM2tnFjDoxMhmdJybOmyOq4xo012FnS3FTP2x87Eycw3nNrsujGXBvzynmfj4Fc265Y2MIqZGRKZ++WyvyqUVFqQGDEXGWp3JDP0YtRY0qZ1gQyxhDob5xgw4pBT4nrHlsv3eLGDbvcdS//TS95+HdYDuo7u4pP3/iMMoSrV6+agXzrXS/6sfvccB8nz9hksXSyXCPLFcPRTcJ6hebeAj6mHos2SdWPnHmcperJNsmuo6knzifwilcyfdnL0dytKKnwuaYhlu36Nme94AZWPQ3JZBhy1mIul0VTyag0XAFq/YMcJpyEQ5rLlTgmFzFi6oMQLBXo1B67ecTql38F+ehH8Ivr2PoU6WMqnR7SJcXAhYgLER1i6tSWTRtnOVQ4ljDdzBjyNqzSqrG3i1sSisTKO1KU5G5zmyXL0l2OmgcUZYJUPTkBlkGthuOOzUw0RwJmCdtsWaPEBGz+tCN95vKPZNPGNccnk/HMvWRzspSO3478t+ypKgVURvdiNjOsrLW5VnZtJi0naziWZnMj361zminBUvObWILTqgva8jNMocsWUyKUeFffUcyaqgvKanFKf7rCrWEVluiwQhdr9HRhD+1N3/X7fuu3vfEzrSV8xia2rB380e//oTe/ptv7bXGxsNivhVVWkY9O0aOTlK5rRjBNVWqnk9x2zVJ/PeeInU/t2KTDu13ipXuZv/YNeNlDdIJpBwFUcimsGhGYJXT5vYKJJZCn2PvJjHClzkEpl56ZgLRaA2MUWzYUQQ0frXoU/DrLH4nIzSPWH/ggPPEkfrlCl2usT3UNQxiLrWhOWS79GtqowBYILFLe8rVrd6VbSPvWjZhVLqrk3jYLbJTKo9nQMI2srtuohKVzZVvD2DzAttb0LLvm3F/L+jZNjFJRubKhM/a9bJ//3Fc9d51F5xqzLas+WFOqozTPvpiNJV6keZfRNDWNMRIgbSn3JISBoe9Z3TzBVjHVYVytYTXI8uiEuyez+77upS/9YQP3mdQSPnMaQtIO3Dvv3P+xO4mX7Ght9INIH1Il2qMTunXqkqw6Vk+2UuIg62IpOMUBHiYz+p094uteQ3f/i1LQkESiCwRnBJ/SelNHo4wVFKZQ+ibU/ga54WkxIfLLG7WK2PyEij2M5kT5SViDmuIGkJUlvEAG5MZ1wns/gPvEJ5gu18iyh94S84pt9ea8jrKR8r/nKeWjHb9t2ebvtjwG5fMKmWlL7Jsqc9F62pDeqoE06D0NGW4Te5Ktt9ACtoitMJ+yjnLSaHKM99wYCOn+G2JsoxS2wcRxvc8+jJHwxzXc+ljL1zbG9UbG/IfKNUvHLiNHMaYGOIgQtXiJsodCjX6xoj8+wa0H4mKJrtbE1Yp4fGovme9913u+93u/SD6DWsJnZNKiHfyRd73rbS+b+e9mODZWg+h6AcslHJ0Qjo+T+p3Tl3ECna+uNXx6wWKCR7BuQpzPWd53B/41L4c+AmvMr4E16JpJv8ZpSCpsdStaLlAScA2TkByKbEPI8f9WQ5A3gMVaKj1rHa22UH4n5ugzgxgIbsCOEzPwn3iSyfIEWS2wIaSuzYMiQ8DFmPzVORmm9GgYzZP0byVga9TxwjSKxtBgDWqjVlCbqDQ2djo9M4D8+9jncVvTsNpApWII+fqVTKWAfiPzqO5CzifHUT0fYcRRwm8dV/+fiVAYMQORraIpW1fJ91nGRpHVbXdj83kl9nzl1uyRsppSUCZfq85nzXvJ+6lWbI5GqvLl21eYL5rMzMXxCTFr0hYGZBjk9OZNu4jd/fYH7voBPoNawmdGQ8jYwTvuueeHLnUcrlanpnElfrXGhhXx6BQZAjFvIAw66fAuYQYYxFJaC1K5s27CctbhH7iX6cHlVHYMxfcR14MLkvoTRMPFpP63hUmLm1GsKYyqpfJRkw9QK/pkBoCR65JlF2CZc6yjYCERd5BInCju6AbxV96P/8RTuPUqtacfejQGYg5zdrX68hhDsJ2Z2IKjLfo/ouFsZd9tScisjiZlK/UrPBNk1MwNWfOwzZ90MRk7K9Vcg4YIpTHZyrnAhuQnS3YZCbPGQGwQZqN9JBfTqKm0DEtGXeV8N6lQqiK3U58xlxiZlrUE3mhHG8+kOU83nlX20mx9ng/MTEJr4Zr2ONWU9h41EFZrhuUKDYG+Zrn2sl4ec8/u5Nt/3/d+7+s+U1rCp33CEqL8R3/o+9/88rn/Tk4Gs3UUWS+R1QpbLNCTFURLctXARaETnyrSuBR1J+KS+eAlFQ9xMJlNmQ0G7/0I4cbT6PoEHdYY4KJLPQqqmq9V3a/qW1Xzw2gONGHHKbdhs9DJGIdQVPqCTyQXm1gOae4TOKmnN9H3foDZY0/g1iusH4i9jqp6KdOeJXnU9G9yKY4aQutuhIIV2AYBp7oFjRrfxN9vEEdD8LC5Cev2rxoF9e96fMOIthH9IiFLHgPl+tv7opXizX2cR8j1r3JrIuRimBQiL23YEpM5T73f/J52qsLctq7TzlP+LRK8eioyEyqzj8bKeOfFw9Ayr/JQNhi6S2CmZiZRciQIQ0p86nvisEb7NdL3cnJ0ZJfoXvTV993zHZBA+zO3/SmOT7+GkBf5tXfsffdds3CR42jTE5VuvUL65FlgiKQY/xQ41IlHpEPFEaQkohjqIEwStiDANDrck08TfvFfMvzzf4b+7/8H/S//Enz4w/DMk2i8idlQCXpU/QuIOHZXEmteQMEN+pzkVFOedWQsOtZPqIVAqhaSOHt3vMD9ykdSLYP1KbFfY4MiA9iQ8YuYCrCEGOgtewl0dFkmSVhCeEdwsYwWbEzZcwmYqkyEUVJtg4YFGNwE29K/pXBMwRHq94xut/MAt1GZt6oBnDvs/POhIbZqhmx932gpCVMqZFg5zNYZDZme0QS2pL01191ihtVUaZnBFqPNQTKM/7dsOjVMpTD9rC0U862A57THZWEWFiuGxQobIsNqja1W+PVgfqU8sLv3nT/x7d/+8GdCS/i0TnYlawc/9O3f/vBDewffyWowHU5x6xW6XqOLJXp0glkPlspUm4BOXYrzzwlMlloZIzZBdIZOOoa5S9rC8RKuP8380ceYvO+D+F/4BcK//Oes/s3/Tv/z/wr9lfcTH3+CsDohSMAswhDQIaSHbSVkVHMtwgA6kMKQBaKDwSDYqKYWDSMohiO4iLKGOOSAIcGte8JH3o88/jG61QpdBlgHbMhuzZjmLJqFRiXlxOqYrESW3vXfTV9526CkVPS1Rm8vXhGMDZt6BLqKs6UhhC1VuDVbJM85FkbdMBJq9J8YeBITl215We30sTTa9g8UaSuVOBUb7WsyrmSbK6hr3p4TNuICNtaS5XtaTXJ1Jg9FIediIoBZqr9YcBuhaFBSMzrTBc5qRi0gq2ShUxr25HdZ1kTK8aT09tQIRGV9fALrNdYPrIc162Hlwo2l3e3kte94+P5vhk+/lvBpDV2+CjwCfNdLXvJNlyY7LxmeuWE+Lh1hhQyRcHKaVOuMzDsgCmjnEAyvhjhQJ4j3OD8B3yHOE2dz8C4l/TjBSHiAP13B6hS5cRPBMUw/gu7M6Q4P8JcvYxcuInuHiRsrqaR5NCxq7tYTcZoKpBplJ0SUXPA0pB8oRVZIEZBRkZBUfjcow8c/QXjsUfzqBF1FfJCUnKRDSkTSFMZabHRXPAFxU2Uvv0tGofMHG895Q/rnDVnOGaUWdb1Zzm9MUyMeC5XRSr9RQp6bZMRIyOPvWQ3e2hO32q1t74TWd1FYw4aa38wjW+dumyfVvXoOY9pcj9SnU4yKltlolfqyeZZJZTrb99eCottrHrmZAkkAFrNjNNcMc2M26vp0we5qjcx2GPoB1mvWnNjesCP37u9+x9d8zdf8VRG5sfWIPqXx6dQQxD3yiL7tG992+IrZ7Humq4Ct1iZ9QNYDLNaE02WKz8+FcAzouq62/MIlruvocEyJHnQaYWeG3XkP4cIFwp7LNmBqyhLEUpfj1YA/XdIdPcPsmcfwH3gf8m9+Af0X/4rhF/418aPvh6PrEIYs2VMwko8KgRzItEZtndyYoslnDOlNRyM6xQj4Adwwg+Bw1mNPPYZ+5KN0J2tYRWIfiUMgakjJRkYNgTYrkiCbAtJu4pHYNwrAbuAGusE4WvNg2+5vsYPzCqSkSUaToLWrWzPh2ZhBZT52VtmXW51/zuapxCijtH6249trtKnQiVgdG0VWMtGdb87k4OeimVgb+JQ/byYvc51v3Dy/UUy8wrzLOpUCVFvuJ6osjk/QYUCWAbcIrOJCjk6OucdPv/z7X/Oarwb4dGZCfto0hNxwxX73q9/yNffM+TKeumF+PQjDkFD201OsX6cHGWOOcXFbKmbhyh5wRK8w8/QP3MPuV35lKiqxfJrhxhIWa9yqx4ecJ+DSi/ShwwKoRWR9ij9ZoNeuEaceO7yIHV7E33EBOdxP4GUApy6p7zn+PFXUTWqemoJLVZV8CKgFJHRISIlXXLtG/NCHmBzdgGWPrVPMg8ZQcx+IqZhrUh21agl1nzVEo6q5LXvZJuMxVJu3hA7bOUS3GclXz23+LaCa5hRtx6iV0FzPzpE72ynERVoW7aQ9fMufceu90/ybFJ7xkzYpqb3WrfAIzNW+js82SmZFOTa1fysxL810G8ygWeuzPJe0Wrdxb9nAo6ZHm2YQOL/nbAJqzBmq0iEqrE5OmR0umLoOWweirkRPTvWOixdnLz/c+zbgf3DveSQ8682+gPHp0xCyLfO6g4Nv3XWxi6uFuSGIDj3WrxlOThP4ZrFKOeczcmyG5GaaKiS1qXMw8dh0D/e61xMffgnu4Zczf9UbmXzxW5m8+YuRV74KfdGDhEuXCfM52nmEDheTC1KHAQtrWJ7SHZ8gj30Med+/Q//1v0Z/4d9ij30cW59i1qMWMRUsCBLArwy/jslEiQNoci36mNKeIwE9PSZ84CN0165h/Yo4DKlzUUxNYH202kFJGxdjGZuuxEyUWWSU0unluBLckj8ZcxLKeU3twzpfBR834xCqiloU4i2GsYGdbI0NPKNVnc/REGgR/fJj5xOrisPEbd4mJLzlnOtvrKliA7ce5zGqGpMgZGYg43wNvtF6DVTOCWBqQdG6thFWVLJHDcjB7bRhVQaE5j7NUgcrUyMOgfXJKagSQoRhwIYg68UJd80n/96V7/2B15sl/O5Zbv95j0+LhpDBRP293/M9r7hrMvkGTk8wS5qBhICu18TFIrUit4jHcOJxvkvNMHI4rHMd1rnUo3HqU4v3ux5k8uJXo36aQDMOcZ3B/CLu8h3YsMBOjtBnrsO166xuPI2cnuIXuRsSJLW4V3ADDBG/OIUbN7HHnmA4PIQ7L+EuXUTme5VFuqgpkEkULDdxLWHMYZ0Skj7yYbonnoHlGssFT8dW8ckbkaqtW45ItA0C3IwJsEr4FY3OsRFt5OF2nkBbJ2GE/c6SRmU0bNZG/GQU39YmH+fZHM9HSrfz6blMwqokPi+ASBjJTtuDzjNRzmAIm98XE6MinxuJEZLX83w0j/H5F0ykuD8tp6fKyMs35kt4TsaYzHJqvaNfLgn9Gj+f41YRmwVZnSzt0oULd7/pvou/Cfg3V69etUceeeRZ1/Z8xqeFIVwlgYlf/9I733mX50UcBbNhcNb3EALhdEEXUq2/XrX2VKh9/SQX6MzzmfPEicfNZ/CqV+Iv3EVnPTYxsFlKhgKQDpNd5PIUv3+I3P8i7PQ68amn0ceehJs30GGFz9mJvs8aPAqskNWK7uQYe/pJbGcH7rwLf8dlbHeX1O8xoeypg1yo8UoSevRjH8U9+ijSr9Ah4PriogxIHFJVIxzRJEVMFvud0Q1VYtqLdlBs/gL2lcYg5bPWxACaUGLqvOJGQVGut530o3XDfnrG9jzJzr7Fwc8D/ipMrWouz0rMRswHFbW8XGb7nE3GlQHVkptxy+PPMoOyPpEC1G4+zw3TQgyavb2xuO17yi8r1WJIgWTeIsN6zbBaInu7xDBhPkTcWs3Wvdw3777hLW95y38hIjf5NICLnw41Q1xqOzV50Xz29S5AHKK5fkiFRBcrwvFJknxDxMXEjf0k8SJBUJFUSRlDvEd8h3MTwoWLdK94cQrzRNCJoV3EvGFOkwRxDqPD/BzzO0wO72f+4KuZvP5N+Ne+Hn//Q7B/SJxNMN/hraOLCQ+w0KPrBe7klO6pZ3DvfR/hF36R+L73ITeeQdYLpA+43pDBYIgM1hOuP4195GPI8oQw9CmuIuQqytmDoZbDkq2EPaeHFWMsj61GGbYVjTaAveL1gBGIotnsJZTYGjdWwRq2j23+Gyng/L2zvbHrj9AUMd3c+M82zoYIlwzVrKYXcwKSKt222ztnbWfOLSny56ynSH3bOj8BiYWgx+uPwOGoNZyV5MVRWJ5rkRX59xIvIeXYBtAt/92CY1qh6aIl5piX9WmKaxlCqtIch15WRwsuTmZf8u4v+7IvAz4t4OKnzBCuXLkiBvyZH//xN94tO1/DsmeIS5H1CutXcLpAFkMNCHS5s666/JDFoc6j+Z2aOGQiyGRGfOgh3B2HKalI5rgww5nRiUOyREj+b4fDJ26Pod5hBxeQ+x+ge9Vr8K9+DfLihwl3XKafT4kTl7SSnLqs60Bcr9F+iXvmGXj/Bwm/9MuED38YPboGYYmsI0F77OQG+oGPMDk6ya3WE3Bopik3IkYikqQW2aUJ+R23tr6NHZDUcpk0HdOci7mQQSg0n2/JZTnOualyp40m2YwYtYNtAk6g7i32TyX6bDdjREnJO3WussFtI0yoEsT23FlQUtqemYw/LV4huOw12NQOyr0l5lLOE9TGNOYzDKzcaKOdIa5JnkqSOOG3Ze5yzyPzK4S++SMV7xgBz82gKbVS2XlLJWi4k+XrJGyiaIsp4Cw1d0kfDsslcbWEMLAcenRYSTg91QOZ7r7scP/fAyqO96mMT9lkuEoyF956x6V33jGZXAqnn1Dpl85WPbYeGE6XyeedbSKz1PdOix/Wmmx1SfEH1nnWBzt0D78Ume4SJSSVWT0mijkDl/LmU9kwA4vgJF3LKzIYZg6b7mB3341eugD3nmBPPoU+/gTu6es4XYMOqK5SAM66w8zoUGR5g3jtmHjwFHbHBdzFy/ipI37kE3SfuI4sezoLxJiKYFgM1e4DGxOUUo2vDYmwUZ+w/FQlIRNGg6SX6tFOJFdHa7LqtqRNkT4tOZ4nNa3sxnO+IzOVwmC31ejzzimmd8E/qsQ+h+dYc1Jr/hg50/McZjCOEf+QrSotZ/SKzAwqWFckflX9Gy9O8TZsXobWc1KZyMa95O9NxpOaaz7bUBnxojQXqZp4+SubkESBEAmnS6b7h9gQUrv5fs1wfMzF6fRrv+0bv/EBEXnUPsWekJ8qQ0jmwsMPzy+6+I4ErqUQZfrUhCQsl6CR0ljEEPBJHRj7A5KknjhwHu0cevkSs/seQq3Duh6xCUgHkrMVpcoQKO3Ac0iyy63QJVc0S27MKezs4180T+7HC0+hTzwNN67lOQNulcpyBUvxCT4Ibr0g3LiG7j2D35nBx59AViuC9miMuGi5HJtuoPqWl5WsgVGaGiRNIJsDlSnkcQZBbyQxWZpuAItZDRVa4h1t3+czNvzzOTS4bah67rpovrYyz9a6WsG4ISRHf36+KNWUaaRx+a5cosUSRsbVfF4Iq7nWuKYmGrF6DzaPHwl/ZBwtM6h8zpo11TWO5sXzYQYtY9q8h6xjSGKOPjMFp8Z6sWS26pHJhDgMuKGX/vTI7pzf9erf8rIXv/3vwP8z94T8pBnCp2QyWDYX/uRv+ro339n5L+X4FOsHYYjJ7bdcY30KU7bcYNTL+LC1UTcRAe8x59GuY3LPffjdi5AhyMLtiyvLCupPlspJ98ayuq4OzGtqhqADPva4nN4s8znuwfuR174ce9XLsEt3Y90Oce6xLmkbSkgmwjAwWfZ0jz+FvffDyM0jhrgiWGCtyZ7rgtXox1QSK2ZVb3TrWdEeGjxhg0m0zCH/1ArLrTlgdi5xjoG6iTmexw6q/Srpp2ROtIpwLYOeLriJT5yZbyTUMQQ5f9cIzHqvxVTAMmU1hGXjHaQ5C5HJ5nNqGElrj+sWcyjzljm0CU3eTAgb10d+ctvawhiZmM2A5tr1e2nfwbMMaZ6NyPh3/T6bLM2zF1KFpWEY6Fdr4hDohzUh9DIsTu1Qo39oZ+drAflUzYZPi5fhbZfueOdd3fSCrq6rG9Rpn8pChdNFzewr9m8xDUySmZB81FpfWvTCsLPP5EUvQiZdJvKSBJI8uD4qzop6mvMfcs8Eb5I0dQyVgPmII+At91NwjIDbbE53513Y7g7x+jPok08gN49xQTAbgJTpyHogMiB9aQ8/4IfcLm2IOT8hZ0VWYi91DTIRN0lKxXPQ+v8Tcxvt+sTkmrJfW9LEtjSFVl6x8dsozat2vqUEQ7Jhi2ixRgKeN241t8BGvQFGbThJV2uJi7PevTr3KHHPXs8YOc2mSXOeiaEyfthqFq17cJTuOQ3bGu2zDteYHu09tCHQzy6azzNLNjSFylTTLyWQjRARn5LP1ssl3eEBFpLgcRoJqwUXptOv/K5v+ZYHRORjn4rZ8KloCNVcuKvjq6QP6LBOrcf6Hg1rwrqHXJfeSNqBy/c9pvPmLibeoTkYSe+8A3fvPSBrwFAmySqQiIsR0bwDMxinIdU+FAMLKS+hi0oXjG4AHxyiHokuz0OOTDMQD7MdunvuZfril+AfeBguXEDcFG8CFokSiXFAtc8VkgOuj8z6pKEEtMYpFHCwpDFbtA1GUG3rwgx0jE+AJsS4OeZWw3g2iZRiKDSHxYyNUzczIdvaBOmaz/3iG32iSugCPm4ct6XNtNJ9ROTzu9iWlOWMM+c/9/rqE2hxG2u0iby2gmHUhDJSQtVWdEg9Z/sZqIzt684L3d66k3zHpXakw8yBtX832l5Tki1ltaZ91K/WsB6QoClhT1WWq579zr/ia19075cCZLPhkxqfNEMo3oU/+tVf/po7PW/JLdnEQsANgWF5SuxXiSHk5iFJU0zELOKqulkALNc58B3+nnvh4gEqAXFGCSc1ckMUtBZRtdhkC8ZIIKASwCIuWMIBgiCDQ9WhKsiQi6jkNuEpllRgdojcey/+ZS9GHryXeLCHesFiz3Q9pMpLIXsVhFQX0SJDjr5MgURQXCopcTATS05xLkBRUf/b5JntiMGWoNx2fP+GGn9WoR9TdW+9TbcJ8NkYUOtufC5WBJu5DTX+Qjj3rM3rNqZE0bZaZiPtWja1pu3rNxcYf33W+9y0c8b7PRvObOJ43jhN1QTOalebf48JaGZUc9EsFbpBFRsGwmqNC4YEhWAyrNd6YdJ1D+/vvh34lLwNnzRDuHo1/fvlL7rvqy5P3B1htVA0iIQBGTy6XMKwrE1OJaYORoMHy8QafJFOLtlJDnS2i7/nXtxkhqNDDbpcYaaWOrNSxCSVKi8FTohKp6SEpZgZhw6YDsCAaI9Y6ZqcTAcTSwFCrhRkcTDbwd1zP+6hF2MHh7hYOHTKMbCoKXkJw4LhShd4JEc+JW1FSaHagiWzSNuEpmSPpiDW4rqSWkUHirTI/QeqFN6U9m2I7EYK8HOKUpea5zYVlet2qD0SRi2iSLY2XLmMcn5JDCphzSqCiiNKbuJqjVqeR7rvUhnZpXPI91uJv+BOac0uU9K4wnYtoPVeHLVCExBNaoh0CpNuw5ULYy4RBaNJ12oHSqJqMUf+dbyf+tya9UiKWTDxIL4eHyU1lU2NZesbqc+g6lylCpOS0udDz7A+xWKfzOQhwBCxkzUXZu5L3vQ1b7qYzYVPSkv4FEyGqwbIxdn8bSKgIZgbkipNjOh6VeP4C5iY8hWyZLSUP1+y09R3MJkTLh7i7r4DcR7Epci7xC5HTl8LkWqVuJoZQAYQEmfN7dawUjIt1marVXqakWxGxVxC/018KsoSB9zJCpX0korkL+aO5SpLFXwr+QcGIYRNaZrBuvRRVgw3mnk0mgHnbPR04+e+iWfXA241UmDXreZpzQDLTLgF97ZXsC350hyMpcTO/f6c6xfNZ4vx2BYWcKtCLG3C98h4zpoyG0z3VvEYZ+ZuGXWs89ZrZROgBReLwnjWfDp/5OoMyb1OfuPWlOszo18viWEY2wrGKGHds9d1r/2eV33x6yFp8M/rps65/gseSfMXe8c7vvnuy07ezHoFIYgbDDeQkoH6da4wpHhcDR4prca9pTr3JgLiiM6jfgJ33YVcvpivk3LEE+FmdbzY6qY1uCyFBmfToVRJKqaEWi52OZYto5gYpVwaeWFEUEG9R+MafeYTcHREagdpuWP0iM5prsrUxhVY6eUHGRsomYuu/h7jiOzXIqi6ZdtX4KuwlPNJwNr/zDaI9tl+EgyTmdKZUdKetvdUvs9i79/Cdk5M5Py90xZ8aRF+be59Ayi0cudWz99ILirrsQbQLZ+Va9rWcRvnbnox2uu3zGJc09ZzOYfsRj3jPMY+3uf2Ey6VIKqgdLlsu1kKhc/nDX2gXycNwVJncxlWazuU7uKrDi99BaT4oE9mfHIaQuY+3/WqB95wWfRltuqxGKS0SQ/rJWG1SnXijEy8Y/RaaoWe2pTFXCjFOw9uwuTOu2H/IKmh0tQFUE14RGngWoi+oPOQtATNzn/L2IXp+KNatYWxUhG1eGqtNWCG3DwiPvkUWEqIkqDZ1ZltuRirppEIPZsJRYOAbCJYc/lccacoJrZV15AtAh9lNGe31lkpeua71t6Wzc+aI5v/Q/GDGa6q6tvzwiZh1bVLkdBnvQRFTa6Ss9jVW3dWibH5ohLnliayce3iomzWyAZTPZ8ZlDF6EBoNpfE4WHOdolmVyMJynm6EXBcz57kFdQWUm2chlgtqQQ5f1qwRpC7ksV9TOpTr0NOvVzaLxh3d5EuBLqcTvGAt4VOKQ3j1/vTL9pzM42pQCYOgPaaRuF4n1Zz8oGzc1sV+T7HginNJ4nrxsLODu3QJL5O0pZTaCq1I9aQ+tb75LFmz+i5o1QZqrcTCDLL5UkqqW6mibBHR0gYuIusFfPxJutMVg8VcxTlfvzKFXPgkl84uZkNVC8vfrfZQJWNjHzJuKhrS35KB40NvCWlb5W6IfvzQzhxX11aPt405dHuOZlXbcQmJEKi2ckZ7GsLTEQAs70w2n8fZq9Qzz2UcGwyOQnSyce+VgZg1s2+69DbjK+wsw6nu1/KsxjBryxhLmSdtD8l4QQ6r5hyGWn6a+1az5Ir3nuB8djdLForFPBrNUTNlWK5SQFwuFhw1sF4uOJjI677lW77+vvP2x/MZnwxDEPeeRxRwd0ztLUTF9WJ+GNCwJlpIdeBCpDagECihqTGr7Yn5CqA5SlHo92fYpcMUqpntJjHLNz5QNIPUE9Qo3ZikVD8uPqNSEFW1OWdkCA2URDVFTDD1WFxjTz6Je+p6jnZUnA1oCFhIWopkM6SaHma1qjL5RZTEpfGw9uXk4CFHbhWXGMQG4ZUEhjzK5k/qr21sXWu+3yBURqIvqvatDA+kIT5ji1jbWTfO2kQ1zpk6zacNUW0eur2+9vMi34os2L7E+cFD40q3vzNI4cKyPcfmfSkOzVWXNjNDtwl8ZHCtAdC+o1HH29SO2muXMvST3R1sNiNkLMLZGMhV5oi56E7oB3QYcv5MIMQg/WrFNA4Pv/Ouh14LfFLuxxfMEMrL+bZv+IZ7Lnh5JasBt1RxQ0hlyDXAok9ZfzpKwW30fAzaSSpYEEUv7iIX9xJqGrUSewluotrZ2RTIRF6qK6fviomQiD0FMGZPBDnAN8as6pc1GAyGmRCGFfHjj2GnC2JMRVJi7FEdEoBTwpObQCOaOIOzwJuVrxsik+oDFxqcZIMZnKWuW5kOyNlPn002bGsR1dedKyidtW7PmSPPc15F5o3Nf4tzN+Y557N2VM2+ZRK3mtu2mOULIInEAJr08S2CP1fits+R8bmccelu/VtM6BqcZ8b+xYvsXryEilBriVnDzCwxBDHQEBjWa2JIbQHNTLQf9MKsm7/0cP8tz/+uN8cL1xCuJvzgN7/y/lfuuu4lrNcQVyIhEZ+s1gz9ClFX774AN/UGTel9SOBigOAT4c9mO8hkgg1r1FZE7VMzzGSAoiF3v9GyibNKnlunJ3dkVt8zoEfmDzH7+1OfRwfZ5Wdi1cRwGpGnnoGnn0aGnjhELBgxlOSssctSGbWEeom3qIBlS1yZAZX8ebPq1VPhTGhwxRfY+tkmZDjXDdiOFsxNPFjGH6T6042cS9KspBJ7k11YpLk1RJo6GEnWAsfVxao/FLemnKMtMU5UdbeMY9iYzVikc1l7O0XVABozorgUR3B0TEdO0NH4ILdxjxb4K8+5/ZdqDozZjMWcaBGfakpJ3cIJFyN52ZC0Fb2C7+ZMDg7ZvXQJm0yqKecwPKTgt7ymqEqMSugDGpUQA6KBOJh1CvtT9waghDG/IC3hkw5dfmjv8E0HvtsZ+sE6DZIADoirNSEO+fG6CtwISStwAjjBR2Vmip8IazMiA9NOiLrG2wS/9ow8OiRCl9SmTXJQEjFWBNopqTqyGtiIIaCKNzAUKYTpfMqKjClpRHKqsZ2eoo89ge/XDGGdOjPnhqwJQ2zCkWEsekqZP2+qcp8JldpUZaVxSsmoNdXvzyHvDRW3PMsyffl8m8husQ3snD+2A2ws5xK3DKpOu626G2eiL6E1JdIzEYqh1ByzcdmtLMLm2TyrttP8bH82zlnl8vhPxlDqi6hHbZkPRZOTpmdmvcfzNalz3YtnQqgNsxHT6HZ3kd1dZt4xvXhIfPLpsSp2Wm69m6gRZ12qxJy1VRsGdAiyXq6Zdf4Vr/2yL7skItds48rPPT4JDeGqAdzN5E0Tc1iMiuYGE6rEfshAmo6bXVx9UK17KIgxOOiC4QclfuCjhP/3P2P4t79EfOwx7OgG0i+QOKSfPqQ6h+uY7XvDDSHVOdSBQVJbbqseBCVhtSEFJKmCE4JLROmjy0RvEALx6aeRp28Qhp7BQopKDDHZciW+oWADOUQZxi2v2YRx5a3reMxoLpwHHJbxbFv/1uM5waNzVNjzzt2Mg7CqpWyvV5AcHJQ3dUIJNy6YtI3GrhZ71nWOTNPO1Xpuuf687nG941Lqdy1za+/Tio1f3ITnsON8bIklKLNoI3u3NYrzRq3mnDXlSGKuk6zJ+P1dmE1gPmX/njuITujyuoecEm05gS5pvkroewiaXPghEIa1DMPAjtmD3/zQQw8CXH2B8QgvVEMQJ2L3veUtu3tqL2MVQU0sA3oWIzaEGklW5JmpYZn1RFW6HAMexLDYM+kF7wfc409hx2t0//2sD3eJly4gd97F9I676A4v4WZz6KYofuyzaClrT61PhTVUsI3g/PTwEl5AspWd4fPfFvMq10v08cdxJ6do7tUoMRW7xAynxURJOMUGIRXgtFwz7YDRndRspG0gbDzNsrDdqp0g47FATRCq0r1dxzmvvr1G/fvZ9m7z6Gqfh63rbx68mSrdSn0pxUjOIZZN7aCYKpsEW0yWCoRaOq7Vjs5oB/VaBacp9y2b4dSMICr5mZo1zzBjPVbXN+oOY1Tj5vV1aw+01yqaQDWbneAUvEH0Hf5wD510qMD00gW6/T3s6BgRIZAYh+R7cGq1kE7se7phDkPqU7Lqe2bznTtfd/nya4Cfv0qqV/J8xwtiCFeuXJFHHnnEvuk1999z4NyLGSISo4imCi8SIjb0Wb2n6rdpkwviwOUd5YwEBjqfK8wG/HrJxBTCCZNjx/TxCdZ9GHb26S9cINxxSHfPXfjLd9BNU+OWohp661K3ZNrIweRtcMnwhVhQfW1seAOL6I3rcO0ZJITEdXM/xoFcaVkbOWmWYiAori1Bg6VmMMUsYXuz2vhMaDe03WJDnx3WijoaoexuAXiNV64b/LnGtgTVrVNkg8jK5OmXzYAk2VxXs7xxTjdK6fI8mrk31OUzS5dMyON9bWeEjvckm7kN2/d8DtMa/3KMV2iqOwlnmPvZc5t7KAyfTZdiNIO9GdPDvayhCN18xvziBZZHJ9WYMSzhIiJES7hCHAaGfs1MI1EVsSjEqBcnU3fXfP6aW97ws4wXxBCukrjNF1269OJJZ3ezSnZ4KfcV+wH6gAOGGLfKaFkS6JlFCg6J4CViEvCDx/ukpkvfwXSGSMD7HhYnuJtPweMOe/8U3b/AcOkicvdduEt34GZ7iJuTkhEGUoQDKc+hRDCaUdqoCbm2Y4SoA91qwfCJT+AWC6LG1MotJuQ99W2EAhSmeZoEpVwoNZmlWWOxUTtoXV7YJvEDZ/7e+C5PUuLnrVBGEt8jK3kuk4FN5vRCkHdn4z2ktVC3dgnaSaPhdmQpuk1kG6aAu6V0L/Z1u/Z0/hZDbO5DOf/+SqTh1qmb49znt9lXQdnMeNx+noWRls+lOad93OnvnK5nqZTg5MIebjrB4Yj54N07LnH68SeycE0Ms/RzwDQHwjn69ToD2klDd4PaxGBvKq8CnH/Pe8oSnnuT8EmCig8cXHjT7sztcCMaUYVcYtxCRPuQkpDEKFGxtRBKKppYVTfvwavSa2IIcTohGHQmqQ9eB9EH3OBwnWPSg63W2NEC94mniO/7CPHiIfHuO3F3XcYd7ONmOyA+mS1QYxFSSHN+WTFm3CClY3PjCHvi6eQlCIoEWKviLTAJxtIJBMXlqEizpA0Un3AaaVfEzB3K1lYxxNwZCXQGnHseY5vBbv6+DVp9+ppuiI2zl2SjGrQjhYCb57ANUpbzxhk3pSuNhN7iIy0zbecu5V1k6/xNHz8j4EnDyMhg3haDrur8OQzzDDMoJkXD8M8yiLM6WcToEHw2R9x0wvTSBUzBQ+ryZoLt79Pt7RGObpLSaMZ7VU3xPJ3AMAyEDLK7oPi1ynq9YublxW94wxsu/OIv/uL156cbpvHC9kwGFB+YzF8/FUfQqJIrDGOa+tjHlAWISeOnt+rvN1MQITijd8qKVE8gqDKsB0KIhL4nrhfQr2Hdw3qAxYBbRPwy4NYDLFZMjk/oHnsc/t0vM/yLf8H6X/5z+l/+d+jjj6En14lhQbQhBTYNBjmwyPUKvYIOuGFBeOoJOD3FQkD7xHFTvILVSMTRtMyRaTnV2Sw31SigESUivWysczb/1gY673NrrnX+kPpTmoyUnyZmavxpwYHnGK0pnENnxnsauV2uCbiFp+TPx3M5Y+pAIc7NOynnS1stiVL6bHQJjiNnYCbKp3UxtnNvXun8x1DOcoyt4c4wC0qg0PiJwUYeRjvXmbbzkOp+JqkCAvPDQybTWdI6LSYw1qCbT3GHuxTXqbbP1VI8QlRlCBGNCcDPBXpkGNZMnD7wm1/9xvvghQGLL0RDECdiPPzw/KLyMomOGHuZRSOUxKFhSMxBSJmg5YFY/t2gGO8TSOCfE7wm8Eli8verCM6lzSbeESUkTq8Opw4bykZx4D2yHpieruCZE/TRG8T9PezCPnLpAu7wAuztEydTsFzAJDosGEoPxzeITz2N6wfiqkeyZ8CbERR6MSaZKRRJpVi1pcv9VWeilU2bsIW0adLL13z+eaNKNnlu7WEEvhrptyHWik1/zkvcmrf1LJx3sFabt0jqkSi3ScCkBIeN7jon5ZqFWQJbirRuzWQJeKK4BuvzqDwtnZFSzKlztWBf+TdpN6NuMGIV1gCu+VuTzP7OHy2jr9WfznmfbdOczfPJWKeAKW46Z37hQgpQmKRUaCFpCCIwPTxgJU+CxaqJtd4dQ4jRGPqAi4EuRqJGhtAzkcmlB/d37wf+3VWeP7D4vBlC8cV+/9vecPdON7mfkFBNJQULOVL01Ph8mu2YbwZLDVpULTdsSh4BiWBExLtU+CQ3G1FLD7eEdoo6NEgqFpI5tfgOJNVRdL5LZc6WK+SZm+Cfgr0d9PIhevkAt7+H39lJdRvNUlbm00f4awu6PodZQ62LqFZsvVECFDu+ZFu2dmN96Vt/cYuNs/F86znPj5m3YOQZ8mzqFT7b1bYTlDaOkEIm2xpOibuwusM3m7OeNRfq70XtlfG4bVdfUbU3Pm3MjZqDkQG2TS/I+I7K8ToecoahnTekso+t53HO3/Xd51sWa7SirVnL/51JqsQlsHuwj5tOMj5gOHEJmxJB8Ozt7XPceWwI1ZQqc4tQc3LCMDAHUt/QIP0w2Nx1u3de2HvxLW/0FuP5awi5musXX7r7RVORexgCWBTLuQAaY47oy2Z1hqBb2yfFxOXCEpoSglMxDaNzDu1jqppUDsBSyfXCEHxW0TDEpeBOK8VTnIOoqBPUC+I8blgj61O4cR35qEcuHMDlS7i9XXQ2xZnSf+Ip3GrNOg5jh+aY6iuYkFOnG5W4ZQ71v/S6twnzVkTeCvMKdll5ZKN6fa4bsazhWQj+OZmPcEtTpEixek9GwwJGeVrua5MZuPOJKW8A2VK3z+QuNJKvftZcr8RFpLJj4zEbzKKZz84ws/GdJI21ZSb1lvJaqe9kk/DH+zsLMlpmKOcPEaHLUZbd7g6zw/3EDDJjc/n+XeeBlNvgd3cIN9dlgvr+VbP2oyULNwGN3gKq0ebSyeHEP3SLpdxyvGBQ8UWHOy+ZebcfhoH6SDJoV7L+HLldu5U66KNKVxBzj+R04FQnRtVSAdQQwRmWXYpiiWOWF2WQ3I0hYRGJ7Uo6TwJOPDghuoGAw7tcZGUQbL3CnrmGzaawM8N7B089hcU1K+tTZaYhBxPljRBLXQVGYoQt6VpjB4pCvLUlmo23vVnOI+uikhb3VJLL1DXcSvrf0ntQFJVSe+E5tZVsAth2QlTD7JprbWsabRPVFKbbSuct7aYh+jGEeGs9WSsgaxbaTLY9H9AEJ43Gzbb5VEPpy1Qb6+D8+2keQWGPJfS8mk1bz2YjbiNfR7xnfngA0wnm2kK6ijif1ya42RS/t8tw8+a4x8o9m+FdqsAUQgphTsIrYGrWqbDbyUuBhP09z76PL5gh3DWfvWxvOvFBTVWDkxjSC9NU7LRIOCuiBmrZMFdabknyvzrApBQeSbkNuTd58rZItjadw7mUy0AJMLGxnLa59K8TIWAgPqdVR7w3TAIx+8TFgZ2mtURTJusBC32qypyL4JTSasUUGiXX1nVbM+KMfpBf8tb+3g66Oe+ceq6d3Zznjed0I9bNvk06W+vMmsem6rt5/HithgBuuaair7eEfgvfvZ0lpvS5NZ6DEi58zlosxzJsPbM2iGt7lK/aQ6pJkldaMhe3AyE2GEcxX8+5zkYgmKT17x0eMNnbQZ2kfZrnURQvpM505qDzTC/ss37M1UjP0fggmwyOMAxNsmBEQxANysT5+3mYuRNZbd3mLcfz9zJkD8PhVB5MpcgtmwcpRVmjpkQkyqYviSxsEFDx32tCHwgaaqadpsihzGDGvAGLKZlDSz2DoLUPAqq5ckwkDgEXIhJSC3eNA3EY0H5I3oocyKHDgFusYLmiDz2hH3DrUCsmp/WM60jJh1Yl4XYJ9UpqMm73tppx3RxWYuKppsetiLTdlM82XkhMwQjw5F2HS+Xhyt/ioQBn6YRNFfw8ZvAc2sbIDDbvtL2vCkLegnlCIZjzmMEW04DmGme1l/NWt3HN8g4bM8FI+zxuzZTWdPYZ3ZKJm+EmHZO9HUIOMCpp9Jb3S9SUEmYutSSYHRzgXHdGq0u0lTGuWhUs1epQM0IfmBDvescb33Ehb9/nNZ4vQ0geBvC7yAMkl5tV28U0lxPTyqFpGQHFJVRuxirTQHKwBSWtOFZCLPkCVuoZNDUaS4lzi5btqJRLsdaBtfYMYcBiIPZrNAwMwxrtA/RKyO7NPgYWGukhuxc1tWXLMRWiydMRC57R4CEbJb/OMQVuOfJ9J8bgnv9529NsEdCYJ2LnEumzEkZl2Jv3cZ6XIp+Qjj/nmzN9GWzEDbaJtfy7bWJt30NSlW/NDJLavrn+86C95xpV6htb2Mh4zU2CL/rF1jznvIt6lPcJ5yIXz9VSQGict3hoFPC7c/xscg5FZ+FEYpQxJDekJkxBwrrHq93x1kt33wlw9erzcz0+L5Oh3Pblt71tb95zmRAJOoip0SkENYiGBAhZBRIpSQLZ9skJTnVbWFJ5xDlcVuVr4JDL8VwVfxgbZ0rMUpbERRMOIdUsAeiyFyHkLZ1cNckjkp0+DPkBe00AorMU32hZrXFWNJrcbjyPGlsBFXASkwqQQhuEU2Lv8zmFm1j5A6zlyUXdbY1bNjWsM/apbEbptZdpr1JxgVswrzM4wLmai3tOrcBlaS9FO6x30hC4jBIu9f4dn4Fi2QKQRhXfOhfGKkNN7odtzV/PoSmJI/n5mFDKoZJza2rurJQow8JhUqXnNlqxvMZtl2hro7TryQ+ZaJEYc+EfS/vQmdIZSHRY5zAxJljKh5nNCLMOWcoGFmcihBjpbEKMSWPXhKszCQGNA05nBy+a7SSGwPNzPT4/DCE//Le/9N59J3KJkNOLAdOIE8c6prDg1F1XKxOpNFBt5xwOm5+Y5MQgKQlQCpaBxOSWTPY8gOA3GLLFrKZnIlVLnZFTG/aCgBcQLaus+dqqWlvCYTlOPKe9adTKZFyDWWw8EtkkjGoqlGtkmxxsc81b2tLGnNsfFMb3LARo5f1sf77xWWvDnzPHczCDEhj0XMNaiWmMRNj8bB4/ztt6bs4zR9pzWwZwhhk823lS7q/8W2oa5IzHwqjqOhqpzeacm3+XfXW+wl0Zh6Ss2aLNxhgxl5hNVEV8w/xL/o/v8LM5PTc33kAxN4Xk4dOYmVlWlUIMTJzsXpxN7j13UbcYz4shXM0ux1ftHhx4xwFBIapQioAUmz/vhzEy7ZxN1NyINJVhkq2euj+L5MisbKuLa1pF20j4Vol9hFoSiq6I+CqiTBXnsicDofQuLIVPijSzAk9XvfBsyDHQSI58S1ub57nGNvGd/by0bxmv8+wuyPHvdN6mL70VXrZxXEa2m/ekZ30ktO/xfGIbibjhB+P9lcIwjMSTtJWtm5J056V/4vZ1ak5H1nS2v9/EKKgAdq2SVzU4N+KdjMFNtW9jwbHIhFmvu/mOx34RI/NLM22aVOWdSL5YGAa6+TSbFCWlqQDtqaOTOo8ieO/p5vNkPpS3VgRUo4LVOzdDVSXEaLveu93J9B5ewHhBXoYL3ezAO+ZBUykxlxcVc/XXWjKtEmkiLoEq7SSrBinBI6lOLvfNMywHV1jinG7cGKUUWtlEmlVFEakhna4UsLDmEZXnFAvzajZHSVG2pBU48ZWZlbSUMRKulWB5ThhRZGk27LnCdDT6z9vsG6Oow+XStzhmQyqmhzxWF8qLkvMkdZm/ak5lnrNGwhmi3bpmSwwbOFEDTkolLhrCkjNztc+oPu/GxBmld/n7/LVXhmFy5s21JkYhRauGbNEoC8PJxzVMOa2hIcTCVVpTrLznopFY7rdgKfCo73s63cV3yeum2bXtncu7TqoW48Th5jPakHEjxfAYScgJiQYlp0U7EVSjeUzmk+6Oc1/gLcbzAhWv5n8v+dmBCLNo2oRQxswUWghqLOF9hoCAosJKo8pXO9FKrkBSg4r2UGoYFs9Dm0tQAjRS2ffEEGozlUz4CXyU0T2TzQMrsahGKg2vo8JcAnJKdk+7OVtUXN2zMYNy4rhJyk98lsIEZ2IF8r3UzkjNM6UQUyN1a8myghvUtZdNrhUhb0t/1ctJYQYjGHh+/MLmMbWLE6OpV5h9wQxMNiV84QhmUtu9taBpue+ypqIZtprDBjNoGEtxG6bXLA1DYswPkGaN+ZasrCnP2pqI0txz+ww2n93WI6rzJm26mAZOHM6P9RaK5Lcs5MQMP5siua9TGbVfaH5+BfeorQRE6Jxj5uQS8Lzbu70gDWG/6w4FJkFjbaGmmgESDRXg2rSZsxQlEarLj93ll+SKcmxjqDIZmNRsRmT7Ij2UxB4T5sD4kpy4ulEKn9OYQqQzgpXDrNODr7ZaLDw5b1IpalxZf94mzePcIJysDY0baZx7HJsSmgKmbY1buRCfy3W2cSyjJCuaRr4kSFJLn2u2Kq1vYSpsXKs9fkuSbjJIKax/Y95xFFkuZ57vxj1tM64zAkfq59sMDmgYqTXLaI+Umt1ZHyGFkWytuzlNNu71/GFmSevNtTU67zERnPM5XF9yhGQp4G6ginSSK3SXZ5DvT0fNWDXT16hZWicwc/7OZ1/V5nhBDGHm/b6IdIaOafmMkWG6wUFHristwUCjxlp9UJo3VZHw1gBqJZ6+tI0XdeUJV4IdVTfJGILU+QrGIS4lnaYoyqRBiHOUsmhtwex8I1X6tKrUGX/5FoGNxDPK5HaDPd/Ygef28bdEcHbSImHqGmu4XyvbRrxhO86gzr+BG5T5NsWgMa5ge9WtPb4NIo730FxrSx0vRWjK9W8NyjZa2BYDH693q4d//rMe2dT2kxuvWGc2NjSJ7SOrFZK5s3MuRSpKAROT3uJSPS+EtO+66STdeTOvK/k+OXgu0UASoM6yOY0x6fwOgHeu3Ya3HC+IIUymsj/zM+nC0jAVy+6iiNXgndqnWcbN4+tTKRIg2f0uq4gVQstqsVhOHnJjCa7EHJJHY3RHln9GuzAaox2FZltS8SkbpAJXYrnFmum49YskLqpdfsHuFo+wuMgKoSWWsvXMs3bD1mYZMxrHezkztiIi62PM96znbO6RKadVxHyVxEpH5rwpuTdRfRGreJUxRjGWeccLZFW6CoDC4Mdcg7FQ6mZ4d/kMNhnC+N022yqEuXnPlp9D+bQ13czKcxrnLAfWKNANHEIatyTN52Uvj6ZOOi+99zGzczN3oj4mqKaQh+plSFvD4Yr4J2vEzXnRCdJ14DxoqPfiMq2J5Scg4M0RUbym5xRQVPwM8JY6BD/neEEMYT7t5l58BeOqWuqk+uIN3UgGKg+vgIr1M6ihpjWRBNuoNFs3d0apE20r5pIHYczqsxqnX2WQJmagMTEDl9WxpM0k3cXLCBiNez5fe9SAN8ZYrnFbVlBTY8uuq20py9HlWhs75tnVhfOkTc0N2JKk5xGUNuFFjWzPv58fGDVK44ZxSL1YntGohVK2pKJt/bstlUetJm3cDU9LS3DlHbTvaGMeY4Op5AM2Smo2axjfg52R5IkZjExsvIdyv5vaUP2+ubXzMJYqlosQs3xveeNZNGSS9Yfc2FhkU6M2GwUe7TMxy68ls/SsDQNo1ILmT0mKxvNiCC+oQIqDaamJmGyFNsVZmqSS/DAKENZI31HlhOr/rd8VQpTkNiR1sElFU13efNllJBkYy9letQhLuXZZs3OJc1feEfEkDMNK4AHJOzJWGH5WreocafbcdjlQ+yPceuIiYW2DuT2bkmvNs9v8ho1PbYtIxNzGWs67zhmEvwUzt97z9nXStcbPE8g4ApilRXubCHUeM9iIOWjWdjZtelOl3h71+MoMzs5Zr71xXvNdYSLnMelbMPaNT8tpOcyY3Duk7QLWBqGldyKVdjazK63W4sgnJF3PFd1RsWFANHbwsH/u3ZnGC2II3pg4QASL1qD8ZObXbgbb4t7NMykSwnCUHnglpt5KQ2wbTYj0DBOHrdpGMrxSLIPLZkTRWCCZBs1LKjENI1ZrJC0qMwRpmBJbm0/Gn+2xEXa69X35+9kYgZU5zBrPzCYxwLYiIeMzOjNf+W+MKLAz5976tden0xBkW5Fp/G70Jmzfb/v7yOSrYye948ykC6Oo5hHbzPZsOvF4zbNsbLvXw/hMtte4KfG13Gtzjdhc5/y4hyKtrZnnHNYsUt8K+TraMpayPywzUbs1g9lYc8NAkFLkNpl7ZC+bNzwPxGefrBkvDEMQ750W6G2MLyi0qKa5qFV5aGUTpXOcjJl0BdUv6u84VyHorFI28Qb13xLyXFSr/ABNMthSp5BNSWKFyDaliVnZNFI3aOst2P693exn9Fia+4ExTqH5e+PY5t5uJeGs/g+2S4KXcX6o8SYBmMgt19JqGqXwSPq7ZR6jf/9WWlGJoCtf1Wcl0DZlbaVsIaqiKabMvrN7uGUElVHIlqpugLjNMHJr35XbmKcUYaVhBuOdjQywrrM5fnv96Yyz6x7jcsp7y0e5XD+iFaZbj7SW5c+bIAX2SsWCqjTeWLllCW0J1hsuO3j0zLrOGy+QISQYMeaFpBDkvDA3NmNRHaG18fY3o+fKvZSxIe0Ko6g31ZwnRcVK9RDEpdTQ9LuA+FQopfh6DUxGwAdL8FqKXc/XzkxtoxagbL7gqrpuqd6Vybebpt735s1WidveNyWK75yNdIbgRpDVOBs7cOb8Soxpx2Va3jhHaG3mUfOgkcyb0vXse9xc8/jv6OorT+Mc7gmMuARFMpy5h00CbNbWfK6V6TRraDTGMa6gHN8w+Y11jw/pvPfa3tv2fT/baBlueg82EnR+POIys7Wqf6QQ542nntmKSP0xE0yLcE4MM6awf+Ee4InnsUBeIEPQGKW16dJmStmOzo2Lq8vOz3UskGEbHDbrAPX11+1iVCmiwui7FUnorIHzUpmPufSQU/iC1c2jqohPuQ3OUrqpJFuikXQjgRW6LO9iW5LV+yo/W9/dMl6gCX8tcRplU0lew611ugLhbeY1jNvlOYaUR7Il0TZmp7oEzzVDMhOqqN3zGJvMYGtJVohhk3hHptlIdLbXftaE2L6xM27fupbmM8Zj617O6615B2w+bzjfbHwhYxR6MpbrlxHQxGyjRKBqTsVn+/1t7gAnLmnEWZAmgNs9bxd3GS+IIYgkck+9UpNxEEkdaKJLufVOI4pkiZxfQSYsQ8Z47I2b2/pd2r+kEmx7ZNSUSFX0Le8cUQ00VpzAiaRIRHGEzEjS1C1IY82VGlyyIM5F5W8kfPt9s+CNv6z9qzAeyI1hso1Y1QurKl471SYOkxfSqJbbWmZCyreZlGRX1iiFz9NcgJyGPh5xDimf+2mZsKDxm5pEY14U9X3rVkdwsTFbGB9PW5bsDEPIc9UwaUZtx/KMY9hv8zyzqVHX0OzX7YzG9mJyy+/Gceac8s7LekUgN9lNr10R8wiSA+yoe0SdoH2/AeAXQVowGQHMC+aSiz/BE5LD/509X+0AXiBDGDI7tczBIkDn6cTTS4rD7kifV2kMdUMkviD1rqrs23qyY9BLDh7a8se7KrGS2eBI5dqKFFME511OjU6vMfV9tWY9JOKx0rKz6e7TqIn1szNis2AJo6nUnFpPcc2nCajKgSiWr1n4fTm/uU554fWLRpUo6Ezr6hzNj81RgbtmYduCIxHsyPmsYSDp74bJthJbmvMtPY9RyufYjBzXUN651fNsjPHYfvatadOo+vV5Nce296cUtbmZb8McPSv5jSYUunE9bo68S/LHI+B49oFX8DAD5K6uLN2mc9mDJmVaySEyUvdV8T5E0cQQUCyXaC/BZOLS/um8Q1GiRSaWAu8Kw3nOenlb44WVUDMxxGWObNltmnaX935D2khW71s1TRh5dFULM1kUoq9oayG2HFG4sYwGnBIKoRdzIE0yVjWS+ntRU+umzBIhZV1vX+P8MubpMZTfbp3uWkau7LAhUUZJVnpMtaNVo5uZtvbfeRLq+UQ2ttcYPQnlWuNz1Y0bEdp1VROouW4l2Ez8rYepUO95vHVk0XJmrjLG0mi2ue5y7oZW1TKcfN163iYzKNeve7ZoH+c+x1E32H5jz4HksGlmJ9zLd12jZVpN5EvHuIorOTXCcrX5vMt9lXlV8ZUu8/o1C05BeeLarbbymfHCGIKXWIozbLgFDcQ7pPNoPyRmYYxqcCMhtyVTUULLUaPdXkThqKaWTD6FEX3NLzxFe5VNldUwaZhBRc3T7yWpJZdg2IA3gI1XvC1dzTaxEja/PnOH5f5GYZhjM+Q8if6CGPqGdlCf0zlSfDN09zz7eCTgkYjbucvaW1OgZSRnmUGJ4BuBwW2TI2sQ29c+e5cYm/a7FqnR7I8xfbmcRSXuArRtAoib978NINart1iHbX6/Ocf2qkf1Pv1jWUNIhX+LRlLE2WgO5Yv4bI4vVhvzGVbd7mk4nPgxjd8s42lCUIvwqG4/+VuNFwYq4oJ5h0rSexMRpdyB3GihQczz5Z1kxL8hfhuDLizfkBio6Ji+29h3lu2womaWlCgpUkcYvQpbY1tqKqWyklUtoNQ5rMe0m+ZcDmZnCPnsw3Yb3yXmU2ox5PlNzwV9qov1Od5gCwS2nLbGbsj4d5vvUDbUrRSKDY/KOfdZTIG82tHzYSNYOxaKac3GkYGVuQqWcgZ8tHG9SMZe2uWYG99jNRPGU0bCz4QmsK19bEQgtsxgW5BZ+egcwPXcJwjbvSFLL0fDUpn1ai6k6xV3Ii43cy1ZmP2ALlfnmnjOeUR8+rfQTSWazLSdC/VWn8d4QQwhqK6DGaUDbSd5c2Ru5SYTBj0dn7Eb27kV5rHJUS2DjAXd/f+39+ZRlyRXfeDvRkRmvvd9Xy29qIWMzeYjzBEeYIxhLI8NPjaywcbG7TnNCIwwgwEzLMf2oGMf7LGqyjBgbMngg7FBBy0IgYRkJJCEaFBLSKB9AUm4Cy2tFi21utV7Ld/yloy488eNG0tmvq+qeu/Wd+tkfe+9zIyMiIy4cZffvVEYxQacGByNM+nqPLiIC2PPwOaQV8E0JFORSU0pH1NcsdlCW4jDkzRWJSj9pUpFmZr0pS65mfLKXa6ESqEYGMPgJ332uJYDRsj1fWkFLfXvYiKVnoXqe5pcdb9V74YKSeWwhhcSiH4uAVhjrwCVt+Y+SO0bnyvVJwCKOK6vqaSuMW2egQRjrWxKFBfEAIY1EWAXRwhD5o8/OAAfLFMdqShH55S1YqtIWZ9koWAmwBMvDq3OgK7MqOjD0nO0vJvou2dObhFrHdbRYhbAcMYJd/e6gUve2ksph0tH0BLrGlQPCh3CmuFQE5FxzPgTrZ1J/02/XeLFjahcHSdpejOSw0heT5QSipU5RGln+o7DQaRJ0roEom3j/Sxb5kVuMlqBRswAdT+OxPdYVNrfMkkK9Vgc4zCmn1fflHvDo5I/8wJD1eUYtqqqO1TC2/y80U/FuMhAoUtRlnHL36yzkcFwpeYGVb8pWz5WB0ug9xGNi9R4AsFal8qkGGgYojRFJJsmrjxfBOCz1HM4XRF0ebfvd/f6JSyDgvfsKeRBZQBqXRJ1mQgwBsbaWpQblJleKAtUVOHLypGrwcNx0rPawHUgllKAkMI4h1SGYoDLIaOSymET7HK6a/P9OT+/Ys0e3GSuaGAgk79Fu9U1i7I/y4k+9nEPcyimwRspVJNv/PzxOUrQ73RNxchyHTdRWffyfZcXbMSBFHUbArP0t/IZlSSxYRxtopTSvnp2IZUaSRMIZI8NEYEMx1yzAq/n6Jtd7e5C2SoXDaGIO+AIzlOBRseU5lfwIewDQAiXZ0a4IgnhHIXdFa/9Cc82sMHKClqxZcIyMPzcwhJAnrGi6FNtHPx6hSaIoOwRN4MtHHJTAynPnRrurMAioATVxGt5OBmUCw8ujK/d6KqWaqK1GQ/OMRZimhg5zVuqBpuRRT8AgMkBRsMVbNP8KCNAtSVAlrR00hg2SRwlZNDNsE2xhsN1vNZl2KTnhYoBFSpGUk2KyRClBMZU/3HCIwypXjk5GSeBbIBLlhjSPgXUg1QxsyGTKNo8lCqq/oiRh2FYvw3MoYz1CCkNECIGQeprwLI5sXPiAjDKCFV1CDBsYTxhTQzjV+jPn0eIY6relZpz/JA1CIZhDMPBCXO04o73fnVxssIb6IoYwjL4XQKtDYyVZsj/PnaSa1qExiH4dXr51lnkZqgBiKM9IIusQxrubFRIS9g0W2oxXyWP8lsersk9NSh5U/GXYgV5MOSL0ySCPCytcETVEy9nBeKyMcPPyHpuef3QXgOilN9w43MGbU9eBa7Pp4kWJ2s5EcsyUq7MAW2yK5RtTSv26NrUweUdlQo2tCVUZU+OH73eZCDdxHuZ6ruhjUYZfkJPRMYIEFzTwLQOHoJSsKSrveB4LEVUbiv2g4Pdi7IUcv0ENeCr7UHKkIcZtSkQwXO4ACDtzTpR/YouL+ty/Lvv1xd84CWIZgyK+9GH1GBDBtS18IuViEPew5pOjCMhiCgUOabuWShNGKyoQPQyULIxyaDTrDOUrttE48khpBN2MJ1QFLuxnE3nKhF785yV55erUuGtSGNm6jkbrNvlG84pvDhN4lLWSZ+ndMlSZC4Y9KbJc7nMQKWhXBbyNYolGZSdgUc8kNyyAY6L51Tu1Q2Li5anqc03tieOt2G5iYoOT+0fNjo9C6lDS+XQtg0oqtEKmqM44bU/xS5msLq4h9XBAg6ALd4pQ9QNsiZ6GoSJJKZgDGANrQEsAp+f7JANdEUSwr0Hy/P9SeyTtScYkhXZI4f/AgDNOvgLuzAsuzABHH2uMd8AK3a/XBnKX2KnUn4pebLUEyPbA8baOCUxWAYCJlaM8j1K8brSTFHBn0dzf2KQjZ6TReD8G2fReOKJh+nE09Ur3b5CoRhEymjH7YgrK5c9HCfhoGkhujh15ZbHjSd3GIyLMb/M+Ixch2KiFeMkXzO4vih8GLKO6h5186JQq4ZlUuWRwADLoW1K9+g7nWIwlWRQ8BECbNuCjZHJrAtJ0UCVTigwFucvgLwHk0kMA7FPkoeMJNZHVSe1SJrG0ZIDr8L6volu2UiXl3U5Zmz95N6F857pPNsGgQz7AHEtpohjA5p1gJUfQpDtpTTMM+iLI0owXs2HUBsEkTsUxQvTz/EtMopj6t2QdFCtfExfq3kNNqMTKR9JXxyIioWYWz5RkjxzgtiWKLrJZxXHuB750MzPAZy2MpNVjtK5ahJNMAP5PXqMCFA7QI7IG9SnWEGl37P7rDyGfSn9wEkqKifwsHy5d8xk0vVxhmUwz2ZZsTRkTr2brFoMwHYDGmEy2FSdODUOy12dmAzYONimiddRymegko+SMQRarXHwwHkg4mZKyHcZRGhV2kC02REBhmBdA09mubfGw88QdBX7/fef3fWgC9Q0spuyVizqQMSAmTVxf3sRfXzv0TSumAxx8EGYgg7CxMnrOVZ1NlC/k+H5qdU/SRm6ihWrdWzcRh2+nHyHTlLmCsxU1qz0sV9qtU/PmBiUU/XQgZSyD0Hcciq1oUKzTT1Pn1NMfsqTqOrPok6ViD04ryjMsvopcUd81wmZSCrBFCuvnpjsm7Ivxwz5cKLq0pIZTDGew43ItWiZU/NqH3HlzRLnGMG1jWAQ9FYSd6EukBRXjwDG+sIuDi7uyjWKjIrSBFHEMhDBOAcyBrrlkUZKkjNgsovdxcEDQFb7L0WXpTJot9/30Y/ur0K4x1uArYGJG0tkkZEAa+FmHfrFAgSDdb9C07QoO11ffyBJFhkgOpH0XE4Ygur6TAGKVSwqqOcG4yMbJ9UKriUWWPBUSL2CXnICX8pAh0LO20ApOQqwkTHlOtbf80SiZGQqRelLxrUwUp9csq2FtJZ0+xIABp2wtSqguRCyR2EwK8v2RGY9kgpo0JZBOaW3Qt+/Bk0RorRBGLxvJTPoS33EpXpkM8mzM5aGojTgug7GOTBy2hlGdD9Gr4ZnD2MJe/efg18vYakcZ5wQkwBgrClUh5xFDMbAOoseuHDPYv/eK6r7ZV7HQawx/iJwx6pZw5EBG4OgrjMDBDISxtl10I1OQ9/LrrTxOhfEvRJMBiBLwhJZOXwSjzT3kh41VSJ4/Dy54UhctXzELnDc6j0kkTNdKWnc4pGeHQ2gaYOU4uD4IphE/0wHZKVmstDM1FqXYRmeQ1zROYn56XqS1HJe+6c4RMw30cVFo5j5zSQ4D7C0kaN6kc5GHqYMUftUKqTZlE0lfShDTcYxnZwQF1xSCwvxWNobpRuK53ks/os6pO9ZtjnjATMomYVhnZA5PFgZCmvbB+NK+FCOg6gMv9oXnOuqbk+tG4r7VOI1kdEEAhoYtExicHciFZAxILJRdZY9RCkwiAKWiz1cfOBedCzo3T6FRMfdKIngEUQ1l1ACkI3wfkuA6dgZgjfhgQ/ced85IKv9l6LLNypGt8VFH24PxsE6h2CtpIdGaWwi2NkMK2sA72U7Wq9xBoUzRiWDtELlYZXRiyjcLRqGhPhSo4ZaqQRIIttwZR6GUAOIEspEW4vbxyuzro/q3lLFYPysYZFTjxpHzsng0kCVqQQj5XVle6baWFMWsWtpLZ9lTPjeAchOvHkl5vJLFoIPZUqTSEceSAQDO8cwK3NVHk23I3sUxuemKLuFOWMaUI+gTfVVGm7UUo0JDmibDk3XRoNgvkYYgyTxgTFwDOzdfw7L3X20oJQuXlhZFIUifME1UV0wshCxtcIgQLBNg57DvW95y1vOE6bH5BRdEVIRAC6G/vbVGhysITY2GbBgZdMJzwFoHGjWil8hMNj7GN6peyXUAyNt0gJULwSoOW/akYkQV97CmFWIg7oKlWWU58rfhiqGoiBLu8CU8iLcX7ceq0mfnXTLDYYqIVmpdAu0JJEoY0zPq/9dKYKujKbTMoY0bQdBlAwKXb8Y0GEwgTeVX37PEsfYg1C+Hx60saoDxv1eP5AnPw/vK70wSqViWb07NggTbVMaLi4E2aA1ALBdC2fz9gFlkmAkYzWDe4+Du+8HeY8+2idslAOTLGYMnGvgXBNRjgbeELw1IGPhnIUni+UyfAbA4krg7VfMEB5Y29v6nvasMyKjGCNZXQzAMWFDsAQ7nyX7gu97iWVI66uK+cUEJiTjSuBslCot98IYTPJ9eyJ4VTmg25QNBpWKvunFRhG/eG1DI1oG0+ThHaLbVC3gXKzGlfGxELWToe0K+rfM1qN/ddCG4qioAEDJtYWaEvt1KBkAhfFwoKqUxDCV0bJirlE0T0yb85SVY1xomoBceybKtnrk/SuHMPayvsP7cxnj38r+0Gf0o6k9LdkJUtJUbR9BsSOVaEJSU58hmLaBMdHoFwupxknE9OyfP4/1+V04MsIQSM2nHBmIlTdsneQQjc+x1oKMhSEDZ4BAFgc9PgUA/nnPy3mPL0GXrTKcjn9vPzi4Y701P2eM3fFRZwxGJpUBonGLYLoOwRqYmN8k+UhBoCLsV0TPKKxS5J6QwZUEiZE/WH7TYS67P5l8trhP3TqM/PzE+RE5NNdSRhZT82o0pKGBiot6Xi4DKJ85LCvOtWLiRaI43MoFEDoKa0Ywfh7X9YWaPSN6dFAPYGyY1HbWKzkKxqcu5MHqz6iMf8MJW6o/8r9Jzay8ARVDGo+LaopT/iPPKGwPE20d2JWL8PFYLg+uRxq6I1ZCEWoMZpBzsDMxrJtkZ9HeitcwAB9w8Z77ZGenSv2IyjUTYGOCldaJl89QAiQ5iAphHJml97y7DpeXarmgy5YQTp85wwDw+jvuuHMfuNM6BzaGYcSOoFtVGTIS2904UNumVFPB6yCpB97GlYJqdw6Ka0YrBOcBmQZeJSJnqaBcvfIz4mSJbQjIguF4ciseAclFWkoCw0m9iTloOybPbVh9oPUs+6DQbaeJUluHK2WZpah8bpIGplbMYuKH4aQHiszV5eQbMpU87ErjXO6TYkwU6mXm82N1Scdf/Zxx3TepRUN7TM2wsnQ16nf9rbhe7WAa6u7aFtQ6MccOvAK6G7kBsDx3EYtzF+GNjEGrdhtkNsuQEAHbNFFiEJATkYExDsFZtp1DIDq4Z7G6daKph9JlMwRdjT/0m795fg/4FDsLNln/0bhmIyZdMAHtVlfo6mJNzb5sHVzaTOnlNBUjN87eg1C8iLjSJ9FfmUFkOqwivVrkURxxMJUSCpQRbE5tnjAUxQtFcW+pX1eDZnKlvgQzgFS2YjRa3qEGw/xRPSkhtrnWo3ljOelaptElCopJE5bKSaaqVd22lIKdsvdIa1H1dWKueaVncNrrMDGbwYRO74zrsjKjrBcTbUd5aLlVW4Fs1ynuG/bHJtKFz4DQzlrACk4gZkIR92HcTIUC4FcrnLvrbvB6jRVJaLqNkoOPY0IjHLvZTMKdDaKEILgEayy4saBZgxVw78fOn7sDuHwMAnBlNgR1PfL9fvWRNRGssQgGcW/HqOvFSnoyMLMtsHVpfWdieCKEaCZN8GUC8kZqtYjPCtwoEILDlTjvvwQkZhE7Us7lgSruwBppyPE58aHS2YegEhnZJqFBOqSmXx6UncrP5SUX24R0lB6ALLVk1SGmGxsZLUzqx1S39Mxi4EMlolp6yu5MXQ3riMXEwBKvKNUunbyx3alddRaktFMHFYwj1bmctLk3lAkEtRWlfqmlmNTf6gJOaiGSy7MMa9cEt4AyQBQMqyx3LGWkEcY6fstn57522l7nYLsOHDhnVLYyvgwgaF547N17H9YXLkoQZLQpII0sSZpKJNKGbVtJsCLpvmCs2A5CS7C24Xl7DGv0t7/h5luFIUTp/nLoynIqRtfjPf36o3uN841z1htmJkMGFp40LjtOsKaDa2cI6z2YIlyLOW0LK98hnWhYwBxJteC8Isl1+fr0l5D2NgBQlTn1NsWVFU8WA6xcYWv9N7KposBanEQxMIpimLOxL61S2S2XLitKG9ajwvFHxlMyprJNuYz8rFHby4lWd0F64lS50doSGRQV6dozM6j7ry41JJdz/D6s98gKziOmU957WPqf/N4Ke8OUmsA86ns9CGMbXN3HykiytDgcmepOt/MO5Jy4FomBCOjT6y0R1nt7OH/X3SCOWxjEqZId3PE5IDRtC/VOWGdlpzKKEY4NwbkG1sywDHu3fuqP335O0gdcNj+4Mi/D6fj39sXi4/vGnLNdA7IN2AjSioyVSCsT+S8B3dY8hmECcdNllK8iu/2EiaiIr92b8e+bdPrBYjm4ZnhOyh2I4fpruq5+JhA9GvEQtUHchVSAe4a6ZAX3BaDWicolmhhgXGUGbjwtR/sIqG0rqa6oxd4SSpzOF32hwKLRxjo07Jf8HsbxB1kyUOmjdvdS8grpTYpxqHT22O4qrqBq96Wpmvwc68MCSCs9NzxRTz0nBu2cy2B4Pn0eqhdF3VVNUC9Y03USb6AMzuR37C3AvcfunfeC1z38Ie5BYrnXaS4FQgqbts4iNAaWLKy1tEDAPcv1HwPgcAUeBuBKGUJEO/3e7Xfdtgj0mbZtAeeYXCMBTDrIIlNgBmzbwXYd+thd+rI1/1tJDHXnUEYMRtQgIzKLgdowGvgbBjX0WtQvEBhfW+IPRMdUzEOpBoz7Zyg5DA8FXOU9J8cTO9+rtg+O/WIKPEZdbt13yMxpghlKPxTlFowidcagDdX7mVAT8vfYf1qH6j3VRsjynYSQp2eZ1XuKqlWdxn2QDajjFT71c6pfgXFhVCpcSTlBy+UTAzCNQzubJbtXKodEnUVg7N13DsvzF9ICqn/K4aV2VeOcSBvGSHIdYwBLYstzBpYst9bRge8P7jpY/skVVTjSFTEEdQn+zmtfe/ca5pNN04CdZUFIWVA0NDJkMwoyBLYGdj4THTC+aIGtCvZK9N96ECZocPxbDXTogI4TBoNJp/dMHKUIOnxOCStO9Yh1LCWVCnYMLurEdXmDvksrdFGHCniUJq9KH5pEJfbTqDyM+wU8Znbxd8Vp+FJaKGvJ5eTWyauJO9WGU7RF64DCU0N58nDRF+U9qa1FPyM9o4AlV+5iKdcPykA8h+KZlbU49mkJ4qokxWrWZYZRvpNh/gqp2vRKrvaIyF/Qbc1lPoTo/iZJgKISSn9uF3t352BEO9CF8t6NAAyhaTsYK4GDVnZlkhSFEe1oyKJtW6wQ7v6je899BLgygyJw5cAkDqdOGQD+7sXij5eWQNYRx0rBWMl9kFZAoCeGm4keJUFbNkXkpYkRJ3jeFj0+rDj0F18xCMKUrlxSOWk2gUmmVtrspeDJ1WHEVAbnNpUP1AOxlk7yF5nEUSKh+r4y5kGZQDkpmaRPfWJS9Qo37l+qyunjfp2eAyppSctP9+jQH5RHSExMpZCR3aC6s8j7WDBopeE72CydmWwEhSwcl0pln+4fFJrHZVXRUd2mCwNc26CZz2V7AC5YfGCQD+D9BS5+9h7weo2AAGJGESmSg5bi/8YYCZ0miHQQGQwZC2MdrHEg17CZdVigv/Wlf/AHtwPAmSswKAJXalQs6NPrvQ9+WTdfbXddG2zDbB0hijLGGnCvMfUEOIduvoXlxQvQDVLAIiWYSkw24Bgdo+9HQRxVq5gzbn9igl+KyntKuOkYxnxIGUBVR9IlCXlFrmILaDB5aHqwDvXXpCLoKoh8X7VKDus2MvTlr2pTGN6Tyiwkr3hDrlssqFIHCDVTLLwemyIua2ZQ1qumTYlPypKC1mlYj0hJGwJSbEy98teqjEgVRdodrmusn4dRueX7buczuLYBMcHCgLwEc3nDMAuP/c/eC3+wRDZJcxpBhZwTy2c0roNrm6SSU1x8NZbBWofgHPq2wfnV4sO4/fYDZiaiy2WJQlcMXT4d/37g/vtv3gfd0XQt2FgYamL0lQUg6oJsSCFNm81mMLbJoipJx06/vgH0FsPXkaWLKVdkSRy5fB5YVB05SlG5v66uJWhp4igmV5kdSFZErWdRpwmpp25T3H9yw/m6f5Tx5PaNv0fGqnWtmMFQOtBJUNsxymfKe8gqxUbiIh34gBnUEPGsjjFQSwDx2GQLKK9RBjXykAyqRYNvJnYKs0nXlv1SXU9Fb1Gyx6bvQExpFsUT1zTo2pkwVo4hyxBbiV+v8MBn78Zqb19sCSPWnfuDOAKZyKCZtTF3Yty/gST8mQmgxgG2YTtrzG7w/t5l/0cA1Ct4RXTFDOHMmTNMAF74ux/71K5vPmK7FtQ6JtsiWAI7g2AawFp4I40xQTiY6Rr0wUc7bgz6LUVffTXMyKCQ7N/NICWKGAPFvaMICR4cKtqm3wAdQDw8KAcVleHUw2xHZZxC+RK1PpW3AqLiiPhOUTUSv3pPBM/xABJysnwegPpZ0TjnCyOrDOxcbih94pCQb0YdrFUaHEtgT8mIRnaNhKXQ8zXzIDZxhasNvEm9K96LWFdRaknpmYEig+UiGjZ5d7JHQoFoFYPUgmI58qh8b1ZPijpAGTkXdVHWLv2XGKzuNcolk4hWF5badPNtNK4B9xJpE+ARuIdfHODincIMgmH4mDNMe17dAWnjIxKYs20bUNcKxifmQCATDxdtd22L+dwgGP7sR+/vPwhcuf0AeBAMAYgApTs/sH+e/QdC24Iag9BZgSsbjdG2EeCDGPxEaOczEXFYBKXSMKhCt6y4xcM4f8grcDGoUAy68j5skBgwNiZmySC/nkQD9j2FaEsXpqVDB24xmctVfDgBUA7wYoXkPLEATvWbyjJUTgQVPjPzM0lHTowqtXksEbA+o7hGbRFg9RJJm4YGwmG/l/08JOJ8pPuLvgKixFShQqffq9qkKir6f9IOxBPvU9uS/k48DLV6oMZMInELulmLHiziPQMmBPR7B7hw973oFyvJZxDG/Q4gZwFR8YcIbdfG7OWI+0JS8jRYY2FtA+Msd1tbWPrw0Re/5w8+AVy5/QB4sDaECFC6bXf/fV/WbB+4uZsv9gzbA0fGiNrQx3lhrEVvvHD7tkXTdQgHB8huvCw2pS6iEovAKWlHukbHTLQaMedzfkOVdX+HkobGqdISPbogIuympOWgzKkqP69eQ0NaNQj1Vv1tYMH2qbFZtNfbVLTVOUSq9kSNlAb3ZBG9Nmfz4HPJ5EqQlraqkiCA9B4rUNiony4tvRZrrrzvwfuqVRAq7B3jyUU8bNeUWpGv4DwA828FoxuJ9MgPKLco3NneARmDwAEWBN977O/uYXmwAOL+o7KDGdXPR6EsswQzgQjWOTTdDMJwNLFKBCbFOCJjLEzjEFyH8/uL995z9uzug7EfAA9OQgAiHuHGz3zmgxc9PtW0DmSJyTixehoSowc0VwKhB8MbQru1BQ+KEGIevcwsJWQlQn6rc/ElnZYJJWx0yqOQpAL9jBxQU7klk/iaRcukZpQydqGKZN81p5U1ZQIaPCddV4nrOQeigmmqOsVnqRqgFIq/yo8Ueiyir2bELlUqXfHGE6P8J1Qzg9zGXG+FPCdmhULtYS6eZUbMN7djGENSiPGVNFPUi4zYfbg2Og7dgTm97kQdNywG5eRObr9BnTVCNtdRjq7rYK0Br3vwcoWDCxdx/v77sbu3Jx4bUqNn7ZnKf8sFR84385ngD2BgTVSgoh3BWAvjHIIhbmat2VuF5ad2F+8F8KDsB8CDZAhExETAa17zmtsvMP+h66TS1s3AziIYBlknqEUCQAbWOdnQpWng5lsp/kB0wzxZRD8WRuIHk1oGdCE+KlOY0COrVSytkIV7rjiXrkmTPT5LB+Sg3DRwixW4OhAHejHwkmpQdiRTmjjDwZr07qT/juug8OOyjKFRsgwUqtyVg/qWqzPHtGclA4O+I6rBYSjLoOGzo12mPJ8YYR3cpJiHsgxUdVJpK6uWoz6ZlO+HOJfxNYX2mT0dKm0VjCJdP3oORxyAwcHBARYXd7F3/jwOdnfh1z7ClpHyGyQJY6K9IaoJDICckzQCjCgNkLgcnYVxVvKaugbGtdw0DfZ6vuUtt932AQBp0b5SenASAoDwvIhHWPe/vw+Csy2xa7GO9gQfE6YQmWgvACgaGu3OPEZKQsC8UezzG3AF5STRyK8Kkss5si/l71PjFRNixFUlSUz1VgqY4bwyAVOTRgZFBUxCxgcMJ/7k6pgkC1nx9Kjz/Q0YQWxzuap6yit7CRIaYSNI2UOu3Vi3zlmoqqoWen2KoNRzxbNS/Sj3Rfm7L44cnJQPKp43lApKcFRpa7kSGjHT4nfdMEWYQX5hh2YbSguN1OlgsZBjtUDvvWxchMJOssFeoaTjW69r5rOISLQpMxLHYEI2FrbphDk0Dq7tcD/3H3z1G95w+4NVF4CHwBBOx78fvrD7rvOMO2fzOQXjuG+sJJKMqEUywjmNdjgB7KzEOERjTBpATGnFqcJahx2HabFvKBZWKyTX76MURTcancp6lc8fPDsxGRbX0iVJvQrAxoGtE20Yy1GiErNoHVWwoiQ5XzC0qpyp9pqRz79knDUriaTlFpJa7pd6aA2flpg8OOXMGF6fmM7GOVks7ciS0GFl5e+c6gEg9YuoA5FFKDhoE1MYPEqZXiAxpPsiCIyYo6GwqH0FPiqZLMM1jeAYjIEG4jLEy2CdA9mIQ7AWrmloCcI96/UfAAgPVl0AHgJDSO7H3/rQx+5l+iO33QG24ca0MMYBpgGcgzcG7CT5IwOSAooJbr4Fdg3AoqN5AN5EQxxLiHR1cJFxWJlFXCH1GDIIhbtKoAlXeq/GR5THKBYglsMIk0jHcvVLomX8TaHCw7+eNQRbjikddZIJEmXpJcrfWdUY4DCUGXKh6w/7c3QUz0eh2xMQDFL/VlOQhyKvhMEDprKDoLwnkmGVxFQVqCc+qe0BBU6gYIy5pvk6bYtHnVovv89Ylzg5E1q26GspbfxOapKrAAMDG9ucn0FS2YEbOb+fZJtgwHI2rzsmNLDwxsLMu7jfQmynMSA7A5x47OA6ONuiJeKm6+gg2HtvOVi+F3hw7kalB80QAIEx3377uw/u9/4di8bCdACMA9u4WYsxYBPjGwwJU2CJC4cx6La2xNioIi8zAtdxaFFomCQZ7LqSDlSJ4kWX4rWK+VPHsOypMpQRJaPn4D7FM6TvrH918NLGFW9a1BdmMHm9TqpStaFaFB16CeS3McYitwupXVw8Z1TPeI9QiU0Yi8JTElDV34NVumQ7UwFw49Zk2WB0FGUPKccKqPFwMxuoEYnjcrS+Q2lis3QzRcLk27aDazsABGsMrBVXo4nfyRkY54DGInSW2+0tXAjhXb/827/9J4QH525UeigMIXGiD9578aZ7+v6edtsZahsOroUngI1sfe0ZoveogcyI3tzMZnBdh171faDgp5mGLznAwKeVXlf7+D0Z4lT1KFYxnZz6rxChgcFqPxpANDiK31iCtFJEX2wPkRXbxcAmUD6r9ijUzEAZ3hQIqmYahSFU9XOSfrqSkaGitO5LUQGJYhuHwUwq0RUNq8or26L3hGIC1ZKY3i7vT1fwqXgRoGQFwJSiJtcrBmNonzFpD4d0IH/eNI+vJIPxYVRr+CoJEWAc2m6WGRQhjWljCRYW1jo4Z9DPCH67pbV1+Oxq8ebbbrttEWONHhuGoGrDz7/vfTdf8Pz+ZrsDNQ1b28E0DhxTs5N1YuwjgC2lqDUPoNneBluTV3ddrYrJObWaKY1WhMEAToxCP1M2HpaHIAVrKHOlJnB9VKnZgJqNxUFTA4jyKj6kxOhUpyYxLvHgfMkI5JnKgKJFHxSZgEaRjlfLPAGHDC5KLyDUbtKahp4BuaeQUCaep9dmQyIPzolkRJTtEJca0VlVotSaoecEGEpLmyXCyyUFaw33wNhkhxoSATFhiUqedZvaWQc4yZ9AtlhEnQFbkwBJzjmYxvJ8a057nj/7obvP/R7w0NQF4CEyBEDUhrs+/OG9uxb+poOmg+lmZKwDnByBLCT/ohhAREIwMWU7gMbBzSRluw4IHkzIyj0WX+RUzD+Q4cNiVygnPYudgjNcWFNzeV3Zi2O4U9KQgTDqsqsVG7UqIW6tKLVw7Q0p07+pTl0ymqkhlsor6jF1ra74Q4koEFUJX6rkL4MyyrZV6hY41VGfVQKHUi7FdMRz8RnZM5HbnSS8QlqqJSE9KEpeScOW6yppYqBCjASZwyfv8HStXozvLzdgPZSG8MyiT1zTwHVtti0ZCwaBnBP0r2VJJ+BaONeiaRreabdxfuXf8fxXvuwhqwvAQ2cIiSO9b3f3pnu8ub2dz4lbw945wDVx00lKmZTEniCLKBNjjYBmPodtWmjuA4/s3gqsG5jGYzAI06BC5PoqxSOuyvF7KJGGxTX58+Eeh0tROfDK7wo80vpnD8kAE4HB4C//kRzZ85J39BlN+uLaoZAt15qkWkwe5Q2UpR+vcQGI96ohk2upTe/XSEB9p6V9IzO9ghEnhlmXA5Tt1gOVBKN9kNRDXTSK/piyMBwWvDZ6v1w/f3IEXM7Y4TGzCQyQyclUTEQggkzae4EJIGdAjYN1LULTgNqW1sHynQcHvwtg/VDVBeBhYAiqNvzki1509oFl/xY7m4EbMNoGZA00JDollkyuSI67OQEgYD7fklwJHK3xKFUEVC87ZxPOzCDP7IkeB1I3Tb3Y4SpSWc612IGUUkkm5TF6RjF5EFULrlfXYR1GA7VoUgLwxLqNhvpE85Ux6Y7blzNiGNlDMJx4uiekumVLK1tW+YqySskhfa5BXeVk4qKscV2H6fRzGysJoPo0PlK/6ZiKDC8FOF2BSsET73MT1d3F6TmzCO7LapAGMclCaqyFJdnm3TYdQttwt71DFz3f9r5P3/lW4KGrC8BDyIdQEIdTpwydOdP/6YW91/25q+fPdvNZg/3A3nXEdgVqPBAsuNdNJQiyXhIsRdx308DNZ1jv7wPEIJZt34DYZ5wFT9W7qveW+rZMeRr12zh7av09D6dJCMdAR0y/TQyUsVU9P4sH55PumlbjQYE8FtuRruPK41B6F6ZIPRsc65QfMYZ/1QNad/XObdBuDEUf1Po5QyHKFTNIDyLkPSOlLcMJnKc/Jd5eejAwaEeqG6SdVZDUJXA5Q3cvcWELiQ0o7QQ590F6gUVbcpvK64e/p7s4gg7jedO2MI2F5xB3ZALIiGQDIzDlxjg4ckBrYVoD1zQ863bo9sXqzT/3279xSwQjXQYI5nB6yBICACDqLS+/9eNvvbv373fb20Rdw9w0oK5DUAnBSWZmMRzFhKwAQIS193BdB9c0cfBxpScnj0Hx2LzyZYCL+s41K1MJYpqMFUBeJSqo9NTqeIiYrYcvobqjutaMQZhDFi/y6k+jQ1d4DMpUqWWUMg7qB9cyOPURM6Iklo9sF5HQ8pQyvpLCimdP9I+0u2Q85fX6icaqSeorqsor+6U0IA7vzFOzjr84bJUfnSp+GNoD5LMyCZ0ylyMPTNU2riucy25cIzxQExQTJP1glBAoGhOta8S46Ihd48wSrv/0wcEbATwkMFJJD4eEIMxcONR93/8Xn/G667abv8pbhrByoLUAlLhfS4LIvgcHAhsD5gAYC/brmGc+oJ3NEJix7lcpTDqAq+i1ob94vNptfln5TMxZKCbjeJ+uNXW5KUhrKC1sesZowGsmX0oVyBGCm6kUnYc/DkXkdLr8LXkaakfuaDJehtQDZOmmZgY6dWljv+f+yPpwOETGFqnuCuX28t5Imjr+4aC6aWpYHF5FE8Ni/Pw0zsigaTvkrCuIGZWl7RTVbDLiYeDWwqEBG+L5sZbu9OsPvOGjd/w+gLQoP1R6eCQEAKcjh/r9e3dfv0v2T7e25kRNw3ANTNOArBhJjG2Qtn/Tiaa7SIMQjEE7m8Eal91qqN1FikLLq2cRDwAcepRjTEXpjM/PiDcxvmX0G4ZlTUgKk/kVC5uAlrGJCagUUQKFytJGnhd9LnhkRd/EDACVQAqUZumm5dpboHaCIYy87EtVJYbtzpQnt0oz9TvQzzy6/kpk4ECoVvYrNQ5vujd/po3Xy/dBeRiro9Iy6XfbNDFiUbxvkhHJgCjCkkk8c0aBfo2Bcx1s42jdWNy9XL72DW97w7186pTJS81Do4dFQgCAM2fOhCglfOTv/uvnvuHPdDs/5Jp95tYRWQdYB6YeZCw8ennRVqSEQCwiEstABSCApYXkTRhuYkqYGCjMicHKdxlgI+RY8X9JBuPrkk4JnloORsRV6UardeibYsp1HZ+rxeQpW0VVYRQTURnG8FnltUV9yys3+fGLW9O5ZOWZsGekfiD5pujPYTmJFNvPheEUtao1RTyYDaWIX+vzG+4vbAZqK5i6R6WC2u1YqxaHMSFlBppIxbom7mdCccOVuNdHlBgEi2BBVpCJ1jrAWZ5v7dCuN/d88L573wg8PMZEpYeNIQDQGOzw7gfu+7Uvuvq67zi+vXNyvVgyO0dwDuQsvA8wzqEPAQEWMAHGMgL7qEaImGfaFi0Ii4P9kRhTr4S1mUfexxR315Uxrj7EKcGrlskYa6mXEzOW3XGAMoJhivWiQvW9A21g2LZqok49G4NJq9L24OLMDPJ+mFNUPq30wgypyl8wrLeWUFRE+3eqvORuZLUZXP5yd6lrLwcbMHXNFJOQ3za5HZHOJ5N2cV0GRhsYY2GdBi6ZQmWg9JsxNkoHIkGQcyDrQJ1ju71D9y7x+p/61V89ywDRmTMP2Zio9LCpDABA0QV55u3vee8dCDfSzgzcWEbbgJ0TgJIleGcAF/UjsllPQgQlGQk0Mo1D23UoYb/EA3EdXInZomZMB/DUK2q8rhDDQ/zHnI/8bxoxWaYaU+v8KJXbBgPkUBUaTqqRujM4V+YUGF9bqhp5NZs0TGJcB5Vspp473B9h2ssxbsxQWhqiTh8K8XBcFOrNQys3l5GjH+vvU1SeKa+zhtA2sh0bGypASHHTVkPiWXAWtoxodB1MM2Oz1dB5ooOPn997JQCPU6eu3NByCD2sDAGI+zacPbv6yHr9qxesWzTbM0Lr2DYzoG0QWgNDJiV8SAk3SCysEsxhE8dsug62EUEmD8IiNh555Vd3X3qFdMjkS3JzmQNAobNZkpiy+I+P6DnR+ukRJ0uaaIP65GfqgB4ch0yWSdtAmpxlf+iDo6EKXPzL9cuFZMaVn1X0YS2cDysVi+DkYpy+b4rRZA/BYYxwWKeJWhS/0uVoepPMIwcsaRlU/D5+qvZu2gKW82+If0UykK3YkhSQ0qKpN0EWSSKREKyzcK6JKMaOt3eO0f2e3/ozt9z8doIswpdu4eXTw80QkpTwCx+++S33sfn97ePHyc06pm4ObjtwY+CMNDiDlnLcQzT9g8hFwyPguhZkRfws3XI+Hdn9qLDlnlgiKcvwaDACAjxCvA7ZNcfZuKhhw6Xxso5zqI+U/Rm1MXBohBtlc6YIWuJpRlPuL1ySSgWVqpQuysAWZQSku2NxHrQKLJICCsMo6kmo9ZaM1EA2+I3xEnU9Y9QCZVRmKrNSH8ogNRRG2LFRtaxTKZmkfYQnFolBL+UyJsSaGn8QdwEv21saaIqyiSQSkWJfJ5diYg4y+Z1roqpAqa7GyhhHVBHYEEzTxG3bYuLitgG6ltvtOa3s3N+6XP7S7e9+98HDgUwc0sPOEBClhA+/6U17f7JcvWTPzFZue05h7ti4GYybYdVYhEZEImMLLqluFqJkHdQNLdv5XHZ/0oG0wdiVcgBgetUNcSTJis459qEQ57W8aiXdhEG4LLE06tlppcmr9qVcpGWdRnETVNQzqi0pOnJwf3WUmtPA4l8/v3gWD89hyAGS+pSvoXSxrpSlYTFLMnV7LkUj1YpyH1w+FarAIdeUqEL5HNkNZWZwmJ2JIZmSm6aJKgABJAwi76/g4hZtkDkRExWbxgGdA88a0E7Ls5PH6By1737p2Y/+ziMhHQCPDEMAzpxhBujFH//Eb91j3Lu2T5wg6iw3bQdr5/CdSASwVlZ+W2RNitmWQIg6lmYDIjTdTCInN/m7AVSTrVhtgXLFyByfCwZRwpOrBCGU3XqTB8ZidaXfs65IYzWkgsoOj6JdedVMzUu/A4XIXTKJDf9SuQPGgdR/WSVJzCjlVESub1lGgbCU63JsQsnQSkG/8qCARwxl8h2PtJTauFnSlFA/eXYyMKmQNahmBlWpPH6y7CEtv1oSsT8ZD0GVAdFEMFIAy+IYUwbASe5E2zjYWcdua0b7885/5GDx3z/0tredeySkA+ARYggEME6done+7nUXbz44+IWLpll3XUemdeyaFq6xkvmFDJAyNUunpX0fI1AjxM8antx2MwExURYvZZUPeQLzVOKPOB1obMzKrz4nUqmSu2ICCVgcpVqi94rdgCqGUeMRch1SOcOyB4xFGUG58WwS6VHESZjNzKtEaw6GNlQNyKhIKhgApUCb3Geq8mTJIyiehIfSR55M0idDSDIOHd4V81XJLDGjmtFJwlPaqO+X34fw5PQ7j4+UKyEygZIZVPfG/9VmYKzN/CgaEmEUg5M3XmEDBGvhnQG1TnaAcjO0zYy3t47Tvevwjpd87E/ewAA9EtIB8EhJCBBxhgH6ybe//bc+y/i92YnjRJ1l0zg0roVrW5g2ApbUiIi8AQWbODBJUFq6NbwnQjebwVqbVrH4xMwMhpMZNex5028+Sgo6+jJ0lzZOsGkLu5Y5nnRTUgUGf6dE/AobMGpLHfAD3gDRnqyT1KuudfxU/ZyZUM7zOBRnSvj11Hoa28EDZnBYHw76qzp3yP1pwk6CjTITGMYtjMoYtLAqu6pMlCbiFURG4hIGanCGIkd3JiB2A+dANkKTGytpAZoWru24nW3RrunWHzm/97MfuOmm89Gz8IgwhIcXh1AT49Qpc8uZMxf++JnP/IWrdtqvcztdx8s1o++I+x7Ue7D3MMGC2YJDEOt0DL4hYwAOYM+AMfAhRGMMoela8BKA9/JiVYRFXK4G3B6ISLZKMhhPDuYIUqJ8r0yyB887sytP3ZPjc0WlqvpVvxXAl8QoeHTbpEp1uK2ilFyQpJGqSiOJItc/nWdM9Oign7meXqL7b6gXYfKZlwIAJfQQdOXP9+UWcXGeLl3mIZTKjX1kSDxl1sQ8onJRdK0jjWETY3yMFYSo05whMXUAug7Uzbk9ftJ8xvu3/sr73/9GfggZlS+HHjEJAchSwve/5z2//Zl1+G13/BjZrTm7bhum62Cc7AFJEaVFyegCaNp0qWXkrtYVE50w6zq4aIxJ7p0oaVQW/mIl14l0GKnoXW/ecvj1vjiG6symFGBTtMm6rqJxTaKtXsnomLIojBKslAys+Dt8dpkTYWoFH5IGWqW6bJjwlzo3qMb010KNqI3AykTL8TLu20u88rqusVAiA2ctmqaJyEMkG0E5hlRFgAKT4s5Lxoqh3TVWMi63HdvjO3TOuYObz5/76Q984AP7umvaFVTviuiRlBCAKCXgzJmDP/yKr/i5a647/g3Hjm/thIVn12/Rug3AOiB4BrNHCFFJs4SANTxCCnqSkDwvW2Bx3C42BNimBRNhvV5FLi+2likLN9LeBKXLrYheKxhvkiriQDEYwKUHK+homzgM/Pv6+2jgDQbkQArIj8rxFMn+weVVcbLHAW54cG0h1lfPj3jckbGuVDPIjM6lCkwMTVVNSoGbyx2UYSWZbnHvZEp9VmnAT+r6glCu65YSs6SaKA2vm+gLoHAZ5rYM2ybh+blf9Z9RIyGQPAjCOBWOLIZCjvWUawmwkviEmwahIbjWonMz2G7Ozclj5o7V6jf/35e85E2PtHQAPMISAhClBGb61y984VvvXvCvtTsz4u2GTdeCugamlW3kxedqEUzMsBRdM5oFKeG7AcEuRCATQzLMNE2bJkA5RWg4c8sViqkw3A1WkoFkMA4QqlfV6tpSOgGSO7DMcpRW5YGOX4Zr5zrk1zTMTLSJNCDpUpS8HBPtQ6x7aTsYZiqazHep76vqe0IOoLpUvaa09ok6TjGjpAKUb2d8P3P9RktmsLFWRIPrMsMzceNVk/J9xPMUw5mjDUHHq7VOmIK1sEa8C9ZZuG4G6zrQvOXZiW3aD+b8+8/d+18A9KcfYekAeOQlBADg06dPGwD+ptvv+dmnfPHVf/vk8a0v2FuugulbE9ZrUO/A3AOeJOVaCDCQbM3GMDgATF4ssUEmsmzyGideTDXlLGHtewQOkupdV1DdsIQZGBi04hUVkV4LgItBsGnipNWECski6cZ5cMu1GYCj9xbrbRzlcSDFMoKsMYei/XiynIn6XobUciVUMVySp+ukHNYv9QNxlORKGmTa1jKiKJ7rqf05ZIxR+qB8rjYoDp51JToB8uV5X0eph8zzLBkkSSYayDkyA06ej3I7d7EfZHejhXUdunYb3Fp22zPz6b7/lZ/4pV95Dz9MCVAuRY+4hADkSMjnv/JlH/7YPr+wn83ZbjkyM/E02LaBc021G0029hsJelKbgm4BR8II2FgEkr0IyTrYthEvha5kukELuNBhBzBZfVaykhe5/nRVr1Bw9QQMRVll4hNGnSyFCQnRqPXTdHFerfjIertKFCmxSXpeXYfsMYmTpRj8KqSP7Ch6pBW/hmBXW6dNvNPSBpE+MyfUYeC6v0RtiMehRpmhdFCemvqdQRTyKjwoahIrEqXN8mlTKl+t9JCKS4WSgCQRqAYi5ZskzRIVXgaVFqxmVY6YA+tgWwczixBl24at7W1zP/On3vTpT/8MyaJ6hSzswdGjISEkIgCv+tS9L/78L/u8f/CFx49/7bmDVbBda3i1BvcB1ntQANZ9AFuZWfIOCAwL0SsDAgdBHFIADMBBVAwRZwnONeDeIwQPjZ4MlNeyMbhFf8+DJNW48gxUZ/L9kZlEaTmVmRKK6BMGE5WKa0A6MKfeO1X35YlYrljxfGFITStyHMQqOYwlpDhBYqU0EWtR86qtsRipGeXPIU2fup2pF6plukYoqs1Ay6zKUDVA2z+QaGQPDIwpiWClHFdbUy6tkedxY6oy9IVldSCDj6SfTFy8yIrNi4y42CkClcgJOA/OwjQN0DSgpoVtO2B2DJ9cLP7LL7zmNR9nSVH4iEsHwKPIEIiIY8Pu/Fs//M9ecNWxYy/tdnZmB4s1m7Yl33uQ9zJDnAf5YqCFkFRQYsmhoOIjA2JBA8CBkyGKrIUluVf9c2JOBPL8PHw0cHFxWi0m3JnJCk+AYcorhfq4gcknabpwPR+oHnSVOoKSEcRfC+l1PLBLUZ5GSU+qdopykh+E6b4Rl64BlzWrCivqHifipHRRSCrptymmVtlhpt/VyCgLZQ7y3ZTJIbWnIzfdtORmsR+VkbFiDFR809VfZIYYRiLSEKndwIrkKomHIxo3xvCY1oFEMgC1TXBXb5vbQ/i9X/zAp36Rhds9eJ3uCulRURmU1MD4Q2/+g9+4bbV8VXvsGNn5nNG2QOPArgW7BqZtozsy7+egKdyh4eMaryNSnEx2dePE12fIwZBL4ttQVdg0JIbidPV7aXhMUzSWx7XLEsjialV+FGNHqcsZRZnyd5xOPa9A5USpJ3meJKWBc7KNiF6N4pIwOf5KF2UJvc7fy/aV7Zp6dihCzNXAl3MZPpjxn6es2m5ycNgQtD795ke5FIelE1UYFWNMSshDiPYBSH+QMWIziJGMisQVIJ6BcVaSnjQNjJP9GFzb8Xx7iy40OP/Bi/f/2Hvfe+OF06dP08QQesToUVUZILqQobNnVzf95b/8n65+6lV/7boT23/+wnLFpl8ReQ8THDh4sO9BfQCRBVvV4fqoZzswvAxcw2APZMxijMqLq4RKFTYAvtw3snjb6beJiZNWoHKQb1hdxqK4gnUGYnRRiXL4H5ZaTZWZIWKxLJRjibKSl2AjKiqszDGvqBj+slFKUPehFpzjFSoVqr4Ew96a9A4UJwa+oUNpXMPiGVS3W97b9IQHxlJWKRGqOidGQQCU8R/GGLG3UHxmjE1w1lXbEJCz6B2hdU5QjK2F7SyaGNFojs9465qrzJ/url74Yy/71d97NFUFpUdVQgDEwPi8U6fMz7zsZTf/8YXFf164pnfHZsBsm203AzcEbgyo0VyMDmwMghEoKBsDWIqpp0w0zohUEBjQvApkKO7cREC817kmi5PqRkM9wVR0L7ddZ9RutyEQqd5DIscyDI1/jEMGsEoNlD+XNLXzdJpAldtyCGuKeyhMSkeHT7u63ip5KbfIzGB4bVnnJElwBiaVuQby+l3f/3AtiUl6qZi4PHeTxBAF//pcRFimvIdFtqNq/BBAhmCtFSmRiqxIRrZyb8jB2Bah62DbDu2sg9veDseuvdZ8BvzB137s0/+ZmQmnTz9qkoHSo84QANnchZnpee+69ZduW/FvNMe2iZuOfTcHd000sFigsTHyUQwwwaAy3kgcOWWmoBu/MMW4BEGByfbr8kKTr1grE0dh7SKMA5Wy1+FwqiMYeVTeZhplQx7o+ocjJU115O3hpG8kV0SBiSjUnVB8Ts9GVmVqF+cQmFSrK6muZbuSZEDVjcNw68NG/IOdDXk3Z4bhAMMa7TE8BvehYARD9UF3USrbSRDYcfIixPvi+HTOwZAwB+tiOjQbVQXXoXEzmNk2/NYWz08ep2WzvffhB3ZPv/ptb/wsTp9+xEFIU/SYMASI6kB3ffhNezedO//j93nzya0TrUFLbLqZSAeuiTqWRIxJJloJgvIg2Vna2sHKKkwgxMmMmIoNZNMkIROTVRo7eulAnnxpwqiqoC6zieOSjaXNR5Iqkl1iOhZB65SDi/KKJJmoa/jwWE2pJ/5hVAvsw3JUypCSVCIq65JRh+WEyp837eSsf2to2eXT+E1c/t05Sd8EJcxEZHAKRS7VoagakJHFxiY4fkz8Yy0o5j3w8wamazC3HcxsDrOzxfOd4/SnFy+++Edf+tLXPRaqgtLlqmqPCGnD/9v3fc/3/eXt8LOzB/abxYU1Fqs9wu4BeLFEWKzQr1dYr9YI6zVCCOi9R/AexEDoPTh4gINAn+Pmj8wsACfKE404pJ13MwIvgIP4sUNhY6jWx8uY9ECedEMms2mCx9LlmniL6KqVcD79rMGKPFx5qfh8GJXPKYOwyitKCWkUNj55j5Yc9e8IMJqqS5nU7fItB9Okd+vCaoY2AaqTmWxaDXOwUm6DMSZmN4pAKRNNlnHTYmOVIVCUDmIkrxEvApyDcQ3szIG3OszbHbRbW8CxrfDUq55i7jD44H//6Ef/3uvf/OY7QgiPiXQAPHYSAgAkr8MP/M6bXnYL0yvbE1eR6zpG18LM2uiXlc6kptxFWjrfEwSvYAyYbJIMAokxEVaAPyG6hXS3ZfW7i93JiORRDfpBijSezocwZR/QFX7TjsxDqu0Vm20N5bUaMFWJ/4P7Nj+7lmqGTKW2CWxWl0pmIJT3e0y4jEvQyEvzEKh8e8AEM8DhmY3SdWpE5OilKEBFijrUaxT2baziD1i8C84l6VGxBmwFmg8n4f+YOSy2Lc93tukA9uLZ+y/829fddNMd4XnPM48VMwAefS/DkMTrcNttizfcfXDmmuu2vuoLrz7+Fav71yH4YNhLABOxYgHjIFwzyEqAiU528SbE9U4U3GRjAAcQFPqbrexk4iAhgIOR1YrHkppAksfv6FIhuJdjIButnAMA1SYp4FLlDp4SmaAAjggBHPfPVCqTsEgXXslaocl7tDOn1ZVhjfR5JdT5oU2F8c3qejyMSk9CWQRFqDGoluCk5ibuJRJ5QYIi26jORkiysykdGjUO6Gbomjls08F0c262d8yHLlz8zz/yil9+42OpKig9piqD0qlTp8yZM2fCT37fP/37f2Nn/vKdi7vHL+zusbm4oH5vD6vlHvrVEv3Cw688Qr8C+x7sA4L38N4DIQCBEbxH4Ai1CfFQhpKMfXHgscgLCnKioCtvgFepEQA4DM1qGAvlhb48aJ+Po1wYzlA/Hr8CFVQrABB0Wk+v7sPfqPot3knjSMrR/UmHoMnrEnaCymtiuTFpbBUxWEAZK6Oj3kmUgISpzgMmmULbN7Q0qQrao4VqcBhbS5aByIwkQpSSURFA2h5AkvxSikvIocvSRoXdG2sBJ14t0zggSriu7dC0LbC1jfl8C81OG05cd625dRFe/wPveMe3333zzXtEQ5b06NNjqjIonTlzJvCpU+ZHX/ii1//Pxer5y+PHeDabs5ltsZ1tgWcdqHForYVtDNhJbEPe1MIgbacbYaGaSVkmgoVCnzWTLoMlTgIGgU1xragQhg1iLl0g7reQDYlm8Ln8nr0N6n1QOVoxCRxVkk0GSca0y1KH/FAdUPGd40a6CXlI5bUcpR/O3hNVibQ+sa4hlqfp6qt/lJlB8qYoDoFrsVxOcdHe3Icy+E1GFZd9QXmKJ06RuzHXIc6fzBoMDEyUfJRZFUxiw/hLcSXpeSaVn70Hijuox5swBxvd3VEasC4mS43G61Zgya6bYdbNwTtd6K49bu5i/thbb7/nufecPbv7aEQyXg49LiQEADJ8mfH0/+2bjv3UX/sLL34G8f+xe8+9YbW7MKv9BcL+HtbLi/B+Bb8I6BcroA8IIcD3vazs3gPBA1EyQAgIPkTJgJOUAAAh+Die4g9xdI/ccPpbEWhWxuQXP5ZtAZANdpMruYqgD2EI1PDgPAlyLeoxllWYrAOXUoNJDGdzpUR01hDmUgXbRFRBwNNELfpQgU3pitS343vkPOKAKZ5CBFtVROo33KKvJFNdKf1noFGJEClAmWuxdwIDAjRKSU5ERSDr5Le2RWMlyzIaB5p3wLxDt7OFdrbN3bXH0W/v7L3vs+e+/Udf8fLXPx5UBaXHhYQAyAJw+vRpuuW9N1743T/99I9+mulDO1edMDyn4NoGTbMF7jqwFRy4cXEvB2sQnOhtwVgwYmSkMQiGACucXA2Rsr8AyyqAvKqrIVG4fQ4ESkakAShg6NMvvds6VfLnLEOnlTa5GfOqO1qNJ/8VAKMJZlBKE/KdRgeKOpX5EIJOjQlXbDoK+8AwUerUW82X12XWPv5xOZLYlCo7R8IXpN8o/W5yF0srCWOmPVVDyn1SPkMjIgVopJmRIxN12bBNRjwJAlcmkHMiGVgLbhxs18I0Dq5rYNuWu+Mzbrd36BO7y594vDED4HEkISipPeHUd3zH3/yb1x5/xYnlxesu3r/P9kJPq4M97PUXERYrYNXDr9bo1z3W3otE0HuQDwjRDel7H20J0ZzIjODFbi62hSgNJCx/1CBDUFk467+cQqOgUzcL42Mq7WoltHfK7DW2R1QlFddhdO3QDjG8ulIt0o9ZBlBjWZ5QcTKUGAwtkVSQmmYDpY0jqxV1joKqrhPlTO1zkBCRNExQoiWKJDDYrK/ogXrC67PFFBp3DCdxL4vSgRw7A0QVQrZZU1sBEyQFICBqagxlFhCSA7oGNGtArUPbzjCbb2N+bMdvP/Wk/fiKX/5tP//W72H++OrxYDco6XEjISipPeHMy1/+lg9cvPivFu3OwezYNq22HdvZHF27A9t0EeQhhzUuQkqp0DU1QYXodupCYzICbCJdxePAL1KXJ3sBso1AMeqIfma1D2RIr5CCjZgLSDMhwqjHVGPoaOLQvSlp8toqr0NRbvlbvQflmBlovZGuR7Ip5LAgXGLYDu359cTPjISnGYEeE2J/ltKS0aI4VxgAJ8o0IFiiONn1Nx34OelpjnAUxgMimGRj4pT7UMeQqAcmYQ0EeJQ3aEVjEFoLdA3cfIZmNvPHTl5lP7MM7/zVz9z6XMIty6KRjxt63DEEAIJPOHXK/D8v+uWXnT3gn+Kda9id3OHVtmXbNKC2hURItsKdVYSLhyagYJMnsQJG0tiOaoVSyhkQV8Y0wVScHRq9qFzZZZiJtV0+B2i6MPkrYcMmMpDyePioRD6WKsjwmpF9BMVv1TdA7SrlkU6Vz6qYy2bBM5ts8kQXg58ylDF7U2PoEE1YvM5DlZcq+CoxlcigiVJKdDVSZw9KzJMYNw4KoDzGNNWfNbIzs4tRjI0Ddx1MO0PjOmw1W3DNLLRXX2M/ZeiTb7r7/h94/evfctfzTp16TPEGm+hxpzIURMwMevrT21d8wzf+zJfP3fefu//OsL6wZ/r9JdaLhaAYV0vwuodfLRHWvagCfXRFMoAgqEYOcZAFlvwKsuECQggSSh04uiJrVcKonAzVu/PUiVqG2BpACFEG2LQV/DC2fpPB8TK6JtVh+JzN4ny+RpGQXpWBOIFzYlaqROuyjJJCur80z+X7xmVMi+9Sp+l6E4ChskaxEWpPMPFFmMKWoPcMZZZaiiokP2T7gQFJ6H1kdBKbYONiE7ODE8FGoJxpWtlpyUpORG47NPMW81mHpp2FrWuvNg/sbN339rvve/Z/eNWrblK1eLLBjzE91sCkw4hBRAQsf+LzPvhvfux/+cqnffHJ677l3v6uQMxGmatjDx8CuGnBsODVCuREH/S9F3UhDpjAXlSDaDnmADEWJUc4R000FJNcKImNpXU9gRqizl2s+KL3iodDx30KFY668OGQ5iyEDyc7Fd+Tl4CBGpEfNmZ9VjWgzFVIFHcSSn1VMptS/B8kJ432gSnPSxmFqS3S/6l4rvYNUKoMKsLn1T+t3JG7EQO29COkuiluRNpYS0EFmyikEwlXEDVM8nDESxRvUOTkMIZgjQTUkZPtCMk4oO2ArkPTtWhnM5iu4+7kMXPhWLv3R+cf+OH/8KpX3fR4MyIO6XGpMigRwM87dcr88dvf/sDPf/ITP3Sr57ddffJa08znoZ3toGm30bgZqLXoOweyHazrJHOziSmvo2soWMrJU2IOxqROJNtDht6qqqDGLBDFWAfOakSkcSKVDHaS86WkqniE2MJDDtXny3vT/aVBNJWVKVBZ1rAMVPemWAMeqxhXIkRejrQzXLXr+tPEFZvLSWWMLjdVKZlPlZJAtDmx3iFuRZu2XaPkXWD1PMXfjJMMR8FJ+jNqHKhrYLsWrmvRzTtga4vbq07C7xxb33Ju8aP/7mWvfMXjnRkAj3OGAIiR8dSpU+bGG2+8/Tfvu+N7P0PmfcdOPsVgNgtuPgNvz8HzOTrbwjYO3LoowknuBIGPKqQ0uh5jPARTzKEQ99nTLdo1pNqTnJPFN1/vQ06AKvxCIa6m0tHHEffFZOexO3DsHhwyCErG0ZwAVVfhoXGxvHcY3V8zhSlI9GZ1ZtiO4rfihimX36aIQhG6zMTMPlypSoFRySNCRd9bUBre8d3EvlPbkonBSDnLVq57NhiqZICY6UjARmwl/yE1MVFwF495C2x3vLUzZ2wdw9n9/sd/+Jd/+WcjM3jc2QyG9Hi2IVSketf3f+u3/sW/85TrfuVpfvkVFx64J6zX3oQLK5j9AyxXF7FeSsJW9h5hLVvFBQ4xKlKgziGIa1KhygicRWEO0QjAOXNQiIgCXdkTMk/BxSUkOCoOVKsVU7Dh0fgnfQwndSFB+Yr5pnXI+8xRuQymokq6lHqiVFpLUNgS0vkNrkI9V6c+zyrDSJ8fAbtUyK/tNJtITLKUoNYmuSs1d7SUlhK/Uq57kgJiL6shkQmS6szG+0x2MQozaOIC40BOsoUbR3BNK3iD+Qz22Ba3x2a8s3OV+che+Nl/+rIX/Qgz94839+ImesIwBAApXPoH//G3/qVvPHbyl5/aL57xwPndEPZhwmIXi9X9CAdr8IrFwLjuEXqZ/CEE+MgMOIZPi+4dkltM8AeITCFO9Shr60pEiAyCULnIQjRYAuX6KYi3rEJgFLA0amOpVycOhPQ8mf+U6rTpFSZzwNQzNrx10etrI96lGMKUJDCVBCX1CdGIccieF9Ix8uulpWplCFkeyraEMqYhJDMPZSag4CMU3icDgATNYBpVKQsAknXibTDCGGzTwTQWtnNwbQs3mwPzjrsT29xdc8z86T6/+LveeOMP02fv3A8MusRrf9zQ415lKIkiRuHnfuVVf/jW+89912fN9tnjJ6812DYBcwc72wbN5qCui/hxiTJjQxHVSDFhhZFwVJsx6DkWAcllyeXW7qXYTlGPj6uK+vizPUKv3ZzktKQpl56ciO2Ozyt3e8qsZ0OZh/fk5BGKZ1TP2lS/ifOlO3Hj0wfMQChA4OGXZgZTyVDLp6XwdZUMok1gpIbZuG+GEaMgk7gUOXoUEG0IaU9RI25F0wjgyHSCRLSzGWjecXf8GM+vvsbcuudf9l3ves8/pzufWMwAeIIxBCAzhRe86lXvu+nche+6k8zNV5/cNm7ehKY7iabbAXWCU6C2BTcGaB2C5sCPeHRT5Lkjk3fTydlwNBUWKnE8G6RKvTNb7HMm5bHYO4UBGE+yCZ3+MsX9y6ErKelwDf6h0xQICXRlT41pL9I9GX+RQ7qNibswc8YbJPBRxBQEIGFZsoogWY7IGphOsAbGSBQjtSYygw5m3nG7s8Vb11xlbt1f/tK/fvf7fpDOnt0NzE8oZgA8vt2OG0mZAp05877F9dd/59+99toXPfXkNV/1AC4EMq3piBDYYQGAbQ9eE8yyAbGD57UUwoJeAxHY9zCWEIIVdYGL1ZFsXLlEJMhCqpry9FMGv0hyTUR/v0gaiFfXk3tSu5Yz8V69Kt1B9ZVazxKtl+tXXBxVDIUGJ4VDPQyYHrlXMj2nVhejHpnkEpwyHCLnsojXlFcxBRCbVHdVnQLJfUFtCXJxLk/Vdn0PNjN7k+wGlHdfikyejEWwDmxkS/fQELgFrCFw42C6Do1rYLoWZrbFzfEtmOM75paDg//2f/3um5+L228/OCXAo8e1R2GKnlA2hCG96oYb7Le++tX+e5797C//ppNXvfhpJnztuXP3BN5dmXCwRr+/j/X6AP16Bb9cI/QskZFBjIwIklOBQzwY6TNxZAgKYoIYHhMEh4PYHNL3AuSb/YpRP86TswbpAFf6CipMgsJ5cWldX5+pGY9LY6d/mCSQ0k6gddgUuZilgwkj5dQPDNjBGZ3ziX0UQU/6WCIk0R9R9ZItAEUtJCLYGELPMQ+iLZKjwjmExoIacUnabhvNrEXTOdDWVmhPbBuztRNu7cN/+Gcv+aXTBKyfB5gzl6P7PA7pCc0QgGxo/J7n/J9f+qz5yV/8QsN//b7d+0O4cEBmd0UHqzVWqwX69UWE5QrwJMbFPhoWvQczJBCKGYYB7yVPIzFFDwPALF4KQpyEeiTvgSrgQZI0ceGlGGEF8rqbQD8lyEmvLuYKx9tLT0VZ6qVeJBXPKafgwzlqp+pxpQyBhv1R/FZGNNayBCXPDBd4Zln1IeAkzW4UQ5UDc8SmEIyxMDGBr2ykQmicE/XBtWhsC2cs0Dq42RxmyyFsm3D8+FUG28cWH1+s/90PvuzlLyAifiKqCSU94RkCkJnCt3zLt3zRt37e0/77Fxn6xv1zd/HB/j4WB4FWixWw2AOvDsTz4CUS0vfyWeDMEObgJWRI4M0+eR4Cc/Y4RC9EuQqrZJDgzhEaTRQZRzVdSoZQT/JKeShW2jKSsC6hpkONQglV+MiM2JHykyZ3srMmb2mmuiaTCW0jBzBclk+xv3T3KI52IVXkINGJauSNEYu6tZoYjnOCnYw7IDFEtwJJdmjR2hbcGYStCD6ateGqkydN384euPlg/SM/8opXvIRld+Zxg55g9KRgCEDGKTzz+uuv+7+v+7yf/nyz/PbVxQewOH/A/oDJL9fAwR7W/QFC38Ove/R9D3jEuAcG+yAwaB+SSsAs33Wy619lDoF178iYvjFmdlY9V5KysEgbZYVJJY9Dw3ImPme7gk6I/Ovw3kdmbJaYipLM4HwZypzzUk7bEIBa3Zh8LuckLvFBUXWCGIuJYlyCyfUgJNciR8aAwlgsW67FxKgFkA2tQ2NbNKZF2GrQbxtQa7HTzfw1J6+159zWpz+0u/9Dz3v1K1/3ZGEGwBPQy7CJFNH4rte+9u7vvPUd33d2jRfYrav9sRMnqdtuQ9fFHPjdDBwjJY1rU5Sa7sZLMYBFBpAEtXC1x2Q2RnFEJ4pLK27pDgPPOUWahigLErIIYWaa3J+gpHrvB42OpOKQlTG51irarEiM95W4/EMloamzqXy1TxSNu1Rc32Erk6Z2Y+TYEt1KjSMzgPY1x742QDDqPqb0vnIEbAxXNgIyCroBayNQZLSt7DG61WC904C6FifsPDxlfo29i+2H37x7/7c/79WvlD0UniTMAHgSSQhKp06dMv/+zJnAgP3p7/ruf/4lM3f62GL32IVzF8JquTZ+scB6sUTQfR76NULfJ3SjDyIZhD6qDAzZQTqqABylBvVGBE2mkkBJrHpAliQoAp+qCB5GjCvc2BYV7UsxugJDJaQSAEJVVq2jZ5UEYGFk0WOi3pDLJVNYHeT+Qo3hHGw1zI6Q6xIlmqQOBdVkqt+ruyLT0mhUXfmZWXR/IELHKSKgKfebepKgcQiSG0Pgx5T2WyAniU3YEtxshtBYzJyoCIudho81W7h2fg3dCtz0uot3/MBrfuumR3Wb9keLnnQMIVKyv//4c55zw1+ct88/HlZfcP6+c6FfelovF+SXBwjrJdarFbAK4FWA930Klw4xfDr4mJcxTvzMAFSNEDWDyEj4MIekfqRIwFDPOJkwm9xwRSMOscAPfRVDMgWnIBrmMaDKIqGIynJSbsI+2JQvuWhPWb/Y80mVIUxWsp74BaCp7A+d/KBkR5DiKYn8qiqIS1WDkUzywphCgtDt/iT5qcGqZTTk4OCAWQNqLBqSQCUzm6FtWtjOhvbEMYOt47hjjV96wWdue+7H3va2e5+MzAB4guIQLoNkXT51iujMmVf/y2/7ttu+9sSJFzz1KfO/tjj3AA4MBw82PQwMN+ixQk9rmLXkaE22MO9FrIRgCQRXYCRFWxrQNubnZxFRgwEQQM7ENG3IjIEBKBYgJiqdSvqllO3nmcLgvJQ40QEFyyjntuaHNGmFLiDQKi0c4oYcnhnOiJyMpPYDjMop3J6sLhRlgcl4SOrI0aIgOTMR06Oz7McRRZ2QnleAyky2LWjiHERPQ+sAsg7BtjDWwjrJjtx2LbDVwXQzf9Xxq+35pt37k37xk//mva94Pm7B8tSTlBkAT14JIZFy8mdef/1133vd5/3YU/3qe+zyojm4sBfWezC87LHqL2DV7yEsGX61Rgi9xDv0AewlDyN8H9UFTn9VTWDdEyLEfI06KeJvKpPLlnGUDY6shrZpqgN9YnvSufr79L31tQASvn/qxQ/F9SlVwhQSwmGaRmmculS5UxKJTGrFDajYD6QNfUnhywooElWITM6ABCO2nNImZJykSZecBhZ914LaBq2RYCU7a2Hbht2Ow1UnrqKL2LrlDxeLf/Pvf+1XX00AnsgYg8uhJz1DALIHAoB5wfd+7/d+iaMzJ3j11PseuBAW+2vi/X2i5QH6ZS8bwvSrGBglbsgQN4BR+0FY98mwxqoeoLA1AEg4hXhNiDYHxMhJjcU3EzDlZL6jcqUXKYPSano4MfxobSaIXj00ZpriCgkpDodM4subC0ND45RtIGWQIkqQb7k3pTdBStxCGWWoACOyJtU5Ni7DkkFiALYGxlA0HEt+DOMsGudgTIPQCSNoXQuataBZF3a2d4w5NsNdjDe+6/57/9Uvvv53bi7Cl58UxsNN9DnBEACAmcmQrMf/6nu+5698tWt+6hr0X3dx9xz2z+8FXvTGHyzg10v49Qp+tUJYrQHP8L0XW0EvUgIFQTzKjlAAB5aNZgEgbh4rHzMTSKi95LqUiUChzDYUde/EA3LCEmZOYn6ZB0C/603KBAI8ABQxgJeiMg1ayEZB2mz2HEkQE/YCU5yq5ZoJBkGimolQYJINQSSFWkpQxkAF9kAlBAkyU2xB/C2mPoO1sqO4FbcizRr4eQPXtjx3c56fOG72u9nuHT78zD//5Cf+I975zotPVnvBFD1ZbQgjigkt1a7w7q/5W//wH333F1733D/bnfzBa65qjz1w4VwAgXhlKCXRtA79ci2+79ADbONekgxLFA2Pmmg0gpV0YCKIiyswiKxM4RhqbY2BXB7EKs7RqBd0agfJ+KsGNYhqkbRz9eeTfj5E549Shto/GKHyDMikHnqfs7KSrpyASA/TnpXCi/6WcxsWzyzSmqWyVBVIkpG03cbApMQk9BJjxMBImvZMMxxFG4Oz4mlwNu6dIG5FamKQUtMgzCQq1rZNmB87Zo7NjtN9gT70ob3dUz/167/+mwTgeZ9DzAD4HJIQSiqTXP677/zOb/oLbXPmJMLXrC5cxN7ubuiXKxOWB+DVGn7Vi1tyvUbwPXyEPMs+kuJR8MHHfSRjYFSMf9B8CxLVK6t9CAJtJiCJ7ipec6jt/8ncx1nPNvoZHKUAqhLBHvZCs66emYg8S3TwfK9ui5shwaOy4l1I4COuci8eZicwwxIpMg5DILKihiXVICMQRSpA2q2bIRM/PkASnDiXMmqbxkbQkZH9FpsGZA1s28I2DXg243bW8bETJ8zStuu7+/DS195+z4/f9I6bPvVkAhtdCX1OMgQgGrJFJOW/+exnP/UfbM+f+7TA37ft/fHdc+d5ebDHfrU2vFqD1yusY3Zn9AHeB6x9Dx9kYxj4AA6AjxvEECPhGZQx6GRXM3pgn63pRNH2IOenDI0GlOIjCDndm0gWaa6k4Ttc82shvZQqSguCnCvSsEJX7GT+L6410EkbcjsKqoBJagRkeUJmCrqTVlQBFHBkorQUMyKn7MfRNpDDmGV/SOMIsJQAZNZITAIaCyID27RwTSs5MmYN2q4Lx+bHDOZbuM+ZD9+yPPjx/+9/vPbVQL1gfK7R5yxDUCpf/r99znO+4Uua7t9ezeFvYH8fF3Z3Q1gtKSwOyPdrYLEClmv0IWARotdh1YM8izciRCYR8Qkp3Xuc6DmqkhMMNyAzhrTDFAiasRmIk0ltD8ghxcmjUbgQlYxO0oJKyWPK4Fh9rwBH05DW7DJUmLI6/gozSAESUklHmUBVB6MMgXJOCikAuoktRaYgMASJRuS4oSqIQQ0QHBDIoLWN7KDUSEyCdS2s60BdE+xWSyeOH6N90168vfcves199/2nd9500x2EJ78X4VL0Oc8QgGKhBvhLbrjhxPdddeyfPi34f3Gyx5/b3b2Ig+Uy4GBNvFzQar0Lv16AVh5mSVj1Bj6sQX4N7/vIBCKIKQVBRXATUMRA6D4QAHNIoCY1TooQn5lEwg0EzUhUSxLKHNL3kRuv/qvTNksOlJ6bcBgF8lBpZKSk/MEUj0y7JyejQkZGApSfTJlppFgEgthhFL+hW6npeQjC0FoLH6HmjgQPQnFPRTgH40QqsK1BmBGbruETOydNaLewS/b3bl4tf+L5r3rVTUByTz/pvQiXoiOGUFApLfyzf3zDM76yPf4vTnD4tm30OxcuXMDiYD/wamXMYgVerNGvZW/Jfr0Ch14Co5KLkpNHQnM6JrGbsweCWDMnRQRkZAykKkI0Xqb9A1jhzlzZFrK6kGSHqm1D8V0p3Rv/M5A6JY9IPFfWpyq3kE4K3pDO6WRnSPRhtg+o3UIkA5hYRsxuraoDERITQPIiGBhjRUJoJG6hMQ0cGjjXSWr01sJ2M1DbMc0Mb+/MTDOb436yn/gs+L88/5Ofeul973znxXIxeDBj5slGRwxhTOqJEKPjd3zXs76owXOPr1bPsus17e0tQjhYYtWvzLLfh18fICxW4LWEVMMLA+DA8bPEPQQfcrRkkZAlJ3nlbBjkuNoXDKS08mtehgQ+0pU8RGOC3ldO6nhvZXyM38s8iMQaQlUbFCsbhE74YqVXeUNMASbXKwYXJalD64FCKoieG/U+mJgVmSOiEyT2AbEfEEzcP1HQhQS2QHAtqOlkw9XGwnSWXdfw9vyY2dk5jguw99zX+5e8Z3/351/++td/EvjcthVsoiOGsIFOnTplTp85wwTwU5/1rO1/+dSnPvvzyP3QSR++ql/v4fzBhbDeP0BYe+OXK/TLVQqSUuASPCP4PhkQNQ08otjvfdxyTikogCmuxIGje7I0SJYW+5wOXmZQdFcmOHIRU4BCrx981u/KMGrsgP6OFB+ggCGAM5IwTf7inkgaZKRqjeY4hO4cBU65Cxg5vRkZcR0yAdbZ5FYUZiDGw9Y5UOPQdw6+cWialtu24dl8ZmbHt7Hf2AvnV+ZVf3J++V//62+99kPAkXpwGB0xhEtQuYpcf/31T/vfd3b+yTXsv3uL/dP75RKL8/vsV0te9kvTL1cx/buHX6+AiGD0YZ1QjMGHFCClqeB1n8m0wqu6EevAkZmoHSEU57LDIKsQFLERQFy7I6ipxidmaUQFhwyOQiUSmCg9hMBpYidJpFInGKUoIEjCfA2hlA6kTKMb7sYoRZUYSEPSidImOcbm/RWNs3BNA+caUNuAO8vOOj423zHt1jHs2ebiRUtvuKXf/7nnv+o175B+ZDp9+jQdSQWb6YghXB7RqVOn0kC64YYbvuB/bdvnXE38T46v/dNpucDuwT4WB4vg12vidU9hvYzxEB7MPUIQiHPo494QMfEKe44MIKoXUOYgkytlZ0Y2SKY1PSZjAdQLAWFCAw/BQO1HGSNRnkoSgvowCzGijI1M16e9LlGpJ0ajC5U3aHlRLQCMZpNJGYsSjsCaaG+IDCFupUbGwDYupUK3zsA2Daxrgm1bdNszM9s5houmOf8AzG/cuvIv/Nlf/7V3QppBp4v3d0Sb6YghXAExQCjsC9/8Dd/wBV977XU3XGvDd3TLxVd1PeNgfx+L1TL06xWw9ob6Nda8RFgHmJ7g+7h7lF8DCOh7MURS4LSRDLF8DyRJV3T+6oYyRvMGRVVE4irihAw+G/M4BlwRyTMM1ZIFOPr2kdUURODQwLsAQFR4ZOMflWJEgTNQPAGh8DbEfS40bwGAWAbFbfWQkqEaY2ApMgJrgVbyHjrXwtgGxjp2FtzNGnLbc+JujrVt7zzvutfcgvCy//qKV7w3VhfPO7ITXBEdMYQHQUPR81nXX3/dVzvzTZ8H+vYtXn6do362WvTw+2Cz9OzX+4S1J7/useQeK14j+BWo96A1SY5HDvDMEdDEsJ7BoRfRP07M4GWlVknCiFKeoigRZHWX8yGuwoAGYknlB40pV39SL8PYV0HFeV3ZVfxIzKPAEaTik5uQImOQrdR1N22yBpbiHs5xv01jDKwxAipyFq3rwM4ArWHnLLddZ5qtLazaBgsyN58z7hU3Hyz/x6+87nUf1boeMYIHR0cM4SHQSBT96q/e+hd//vP/6nWw/+g4m2+cBf7iWe/RHyyxWi7DwXqBtV+Z9XoN9DGHYy/QaMQAqb4XuwIFBrjP6gVz3EIqMoe4JRAhoyHFQyfehqAz2nOU5kUCUMRjagEAgOLE1ejLjBFIH1V6KE4BEQ+hrsXCJhAgxsNkgIwSAJFsjqKuR2OFGTiSbEXUmJQJ2TYGxlluTMc0a6jZbsjOOizRLPaoefs9xrzy/X3/xt957WvvBI5sBA8HHTGEh4GmdNQb/v7f/+KnN3jWU0DXz4z96x2wHVYH2N3fR79cB3MAcB/MAR0grNewS0n97j0jRLuC514CoKLaELwXw6C6IePEzjEQGQ8QxMQADS8iziZFQ4iAJ876fnGvMYp5yK7O2M4UaIjC06ASACumIP6lqCoY3QDFSkyCKXJTNk7sAnCStMRaAwuRBGzbUDvvqJnPwU2DBdNt55je8Fljf/2n9/ffiRtvXAJi+AUkr+Yj+Jo/J+iIITy8RKdOnSJ1VwIAvv7rZ99/7cmv+TPGffNJ5r838+HLTUzdtlis2Bwseb1eUWBPSy/eCOoZ6DmqEhHkxNFlCSToM1hiJgg5y3OI0GijWAREGDRK+0GxwUxyTXJyWYLFuAcuXJyqWhSeB5UsktdBbQOlNBAlBo06pOg2TPYCJwAjYw2TNWxdQ7Omo6brEFqHfYt792HeeZHwWx9brN/8azfe+Amte+kafiRe5uciHTGER4hOnYIBTlWr1t+5/vqnfaX3X3818Te14K+fM3/hfMlYLhbY9Qd80C+5F3Qj2WUg3UxGtrD3ACQ3g3gXCBRishMOYPZpRVe3JEUDn7ow1biIZFqIUgMLM4jIguQaVEMjpYlOlcGSCLC2iKAvvApkJHSZkpqQd0+OngI21rC1Dq5tqLWOWteCrcPSunt2KbznAQ6/+5nF4m0ve8tbbgYkwUMhjR3hCB4BOmIIjzyNpQaAvvuGG770i2G/jsL6b7chPHPerz+/Xa/Qr9fYX62wWvcBa0n66n2gEDwF3yP4XiayZxgvU9hHqLQmVNFYioQyLFGQADw47pMAJKSiMQkHQZSlCWaOkz5mUk72BEqqRUYb6vnIBJwgDp2EJLNxDRvFELStmc06mKbBmgirQJ85YH7PAu6tt6/Xb3/xm2/8nwDWWudw6pQ5jTM4c+ZzN/Do0aAjhvAokq5uMU28/kjPefY/fPrTlnjm8RCe2YbwVxrvv7QLPO/7BYJfoe891qt16GNEJQIQQiB4T1QAnAQtHSTiMgzSoIWMYQhAYhgEoA9BGER0G6qskAyJEZ1oSaIbjTXi+jTCVYy6FE0DIgtjiAnExhhBGILIzByZzqFtZ7C2wSLQxWXrPrJn8fYl83vuoP79L/uNGz+JGGmongIAOJIGHj06YgiPDdGpU6cIACrmAOCrv/mbr30m0Vdc7dzXmPXqL7UhfGW7Cn/uGNMWhx7rsIpuS0bomb3vgw8BIW4B5QUJSQSPEDzpbskqDYRQWA04JJxTQIzAtBFfULgjy92RjbGRkViWhCbMsICxBEMk6QhcY5xrQcbCuQYBBA9zYR/+kwet/SC6rT/c7fv3vmO9PvveG2+8kDoFKgkcMYHHio4YwmNPiTlMGciuv/47rvvzFJ6+tV5/Rej3v8yF/svmJnxp4+m6ltyWIWDdr5PRkeMGM957BB+YWVI1sRfbQ2CGB2RnKWYC616P2bZgyUYPBDHF3anEIAiw87BkjLMNORIAkY0eAtdIJqOesfTk7t4N+MiewYfXxty8f9D/zz/aC59497t/9/6yfSo1AUdM4PFARwzh8UdicwBgBtIDAPzZG26Y/y1jnnpyvf6CmcWXGL/6ErcOn9+uw9Ma5qeZQNcAYceCtzmE1hiOdoMAJpEQKESAUYCoDjH2IRkYI8iI42SXPQ2cbJseCCsOWDH3wdCuJ1xgojvNrP2Ud92ferKfWBJ99C7gEy/943AXzr56VdZf0Z6nccQAHo90xBAe30QM4PSpU/TlZ8/SDa9+dTjExUZP+fqv3/7anZ0Tn+/c1d16fS371VWO/bWG+SSx2bHAjgFvWdCcCJ0hbikYR8SGmY3sTSnZ4MiYdWBekTUHTNgHmYtkzEWE7nyPcO8B6J5d9PfcY8z971+tzt31pjftTVXqSAJ4YtERQ3jiUVIxzp49S894xjP48eCLVyPgl589Szc/4xmMM8AZHDGAJxodMYQnDxEgs+90wTBuiCdlkp7B6WKCmktM1hDLPC1iPr787Nk0Xl4NoGBG+ugjeoLTEUM4oqkxcDS5j+iIjuiIjuiIjuiIjuiIjuiIjuiIjuiIjuiIjuiIjujS9P8DJIYq+iRNiEQAAAAASUVORK5CYII=' },
  blue:  { file: 'dot-blue.png',  base64: 'data:image/png;base64,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' }
};
const MATCH_DOT_BALL_HEX = { white: '#FFFFFF', red: '#FF3B30', blue: '#3B82F6' };
const matchDotBallImgs = {};
const matchDotBallReady = { white: false, red: false, blue: false };
function matchDotBallKeyForColor(hexColor){
  if(hexColor === '#FF3B30') return 'red';
  if(hexColor === '#3B82F6') return 'blue';
  return 'white';
}
(function preloadMatchDotBallImages(){
  Object.keys(MATCH_DOT_BALL_SRC).forEach(key=>{
    const cfg = MATCH_DOT_BALL_SRC[key];
    const img = new Image();
    img.onload = ()=>{
      matchDotBallImgs[key] = img;
      matchDotBallReady[key] = true;
      // Görsel harita zaten açıkken geç yüklendiyse (nadir), o rengin
      // texture'ını gerçek fotoğrafla değiştirip haritayı tazeliyoruz.
      if(matchMap){
        const hex = MATCH_DOT_BALL_HEX[key];
        const id = matchDotImageIdFor(hex);
        try{
          if(matchMap.hasImage(id)) matchMap.removeImage(id);
          matchMap.addImage(id, generateMatchDotImageData(hex, hex === '#FFFFFF'));
        }catch(e){}
        if(typeof renderAllMatchMarkers === 'function') renderAllMatchMarkers(matchMapLastCandidates || []);
      }
    };
    img.onerror = ()=>{
      // Gerçek dosya bulunamadı — koda gömülü base64'e otomatik düş
      if(img.src !== cfg.base64) img.src = cfg.base64;
    };
    img.src = cfg.file; // önce GERÇEK DOSYAYI dene
  });
})();

function generateMatchDotImageData(hexColor, isMe){
  const canvas = document.createElement('canvas');
  canvas.width = MATCH_DOT_IMAGE_SIZE; canvas.height = MATCH_DOT_IMAGE_SIZE;
  const ctx = canvas.getContext('2d');
  const cx = MATCH_DOT_IMAGE_SIZE / 2, cy = MATCH_DOT_IMAGE_SIZE * 0.44;
  const r = MATCH_DOT_IMAGE_SIZE * 0.31;

  // Zemine düşen gölge — hem gerçek foto hem yer tutucu modda aynı
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 1.2, r * 0.92, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.fill();

  const ballKey = matchDotBallKeyForColor(hexColor);
  if(matchDotBallReady[ballKey] && matchDotBallImgs[ballKey]){
    // GERÇEK FOTOĞRAF hazır — doğrudan onu çiziyoruz
    if(isMe){ ctx.shadowColor = hexColor; ctx.shadowBlur = 9; }
    const d = r * 2.08; // kenarda boşluk kalmasın diye hafif taşırılıyor
    ctx.drawImage(matchDotBallImgs[ballKey], cx - d / 2, cy - d / 2, d, d);
    ctx.shadowBlur = 0;
    return ctx.getImageData(0, 0, MATCH_DOT_IMAGE_SIZE, MATCH_DOT_IMAGE_SIZE);
  }

  // Fotoğraf henüz yüklenmediyse (ilk milisaniyelerde) GEÇİCİ yer tutucu:
  // eski programatik gradyan/highlight çizimi
  const grad = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.05, cx, cy, r * 1.08);
  grad.addColorStop(0, matchShadeColor(hexColor, 70));
  grad.addColorStop(0.35, matchShadeColor(hexColor, 25));
  grad.addColorStop(0.7, hexColor);
  grad.addColorStop(1, matchShadeColor(hexColor, -50));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = hexColor;
  ctx.shadowBlur = isMe ? 9 : 6;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  const hlX = cx - r * 0.36, hlY = cy - r * 0.42;
  [ [r * 0.62, r * 0.42, .10], [r * 0.46, r * 0.30, .16], [r * 0.30, r * 0.19, .26] ].forEach(([rw, rh, alpha])=>{
    ctx.beginPath();
    ctx.ellipse(hlX, hlY, rw, rh, -0.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    ctx.fill();
  });
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.5, cy - r * 0.52, r * 0.1, r * 0.14, -0.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fill();
  ctx.restore();

  return ctx.getImageData(0, 0, MATCH_DOT_IMAGE_SIZE, MATCH_DOT_IMAGE_SIZE);
}

/* ============================================================
   ARAÇ İÇİNDE (isDriving) OLAN KULLANICILAR İÇİN ÜSTTEN GÖRÜNÜMLÜ (TOP-DOWN)
   ARAÇ İKONU — Google Haritalar'daki gibi
   ------------------------------------------------------------
   ÖNEMLİ: Daha önce burada 3D-perspektifte (açılı) çekilmiş gerçek bir
   araç FOTOĞRAFI kullanılıyordu. Bu tip bir görsel haritada yön (heading)
   bilgisine göre döndürüldüğünde "yamuk"/devrilmiş gibi görünüyordu, çünkü
   2D rotasyon yalnızca TAM ÜSTTEN (bird's-eye) çekilmiş, simetrik bir
   görsel için doğru çalışır. Bu yüzden fotoğraf yerine, canvas ile
   PROGRAMATİK olarak çizilmiş, düz/simetrik, üstten görünümlü bir araç
   ikonuna geçildi — tekerlekler her zaman düz durur, ikon Google
   Haritalar'daki navigasyon oku gibi yola göre sorunsuz döner. */
function matchDrawRoundRectPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const MATCH_CAR_IMAGE_ID = 'matchcar-icon';
const MATCH_CAR_IMAGE_SIZE = 72;   // texture çözünürlüğü (retina netliği için nokta ikonundan daha büyük)
const MATCH_CAR_DISPLAY_SIZE = 34; // haritada görünecek gerçek piksel boyutu — MATCH_DOT_DISPLAY_SIZE'dan belirgin büyük
function generateMatchCarImageData(){
  const size = MATCH_CAR_IMAGE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const w = size * 0.40, h = size * 0.62; // gövde en/boy — "ileri" yönü yukarısı (0°=kuzey/heading)

  // Zemine düşen gölge
  ctx.beginPath();
  ctx.ellipse(cx, cy + h * 0.08, w * 0.72, h * 0.42, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.38)';
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);

  // Dört tekerlek — DÜZ, simetrik dikdörtgenler (araç gövdesine göre sabit,
  // asla eğik/çarpık görünmez; gövde ile birlikte bir bütün olarak döner)
  const wheelW = w * 0.20, wheelH = h * 0.24;
  const wheelX = w * 0.46, wheelYFront = -h * 0.26, wheelYBack = h * 0.22;
  ctx.fillStyle = '#1c1c1f';
  [[-wheelX, wheelYFront], [wheelX, wheelYFront], [-wheelX, wheelYBack], [wheelX, wheelYBack]].forEach(([wx, wy])=>{
    matchDrawRoundRectPath(ctx, wx - wheelW / 2, wy - wheelH / 2, wheelW, wheelH, wheelW * 0.3);
    ctx.fill();
  });

  // Gövde — üstten görünüm, hafif parlaklık gradyanıyla
  const bodyGrad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  bodyGrad.addColorStop(0, '#FFD84D');
  bodyGrad.addColorStop(0.5, '#FFC61A');
  bodyGrad.addColorStop(1, '#E8A400');
  matchDrawRoundRectPath(ctx, -w / 2, -h / 2, w, h, w * 0.38);
  ctx.fillStyle = bodyGrad;
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = size * 0.05;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = size * 0.03;
  ctx.strokeStyle = '#8a5a00';
  ctx.stroke();

  // Ön cam ("ileri" yönde, üstte) — yön okunması için koyu mavi
  matchDrawRoundRectPath(ctx, -w * 0.34, -h * 0.36, w * 0.68, h * 0.26, w * 0.2);
  ctx.fillStyle = 'rgba(50,95,170,.9)';
  ctx.fill();

  // Arka cam (altta, daha küçük)
  matchDrawRoundRectPath(ctx, -w * 0.30, h * 0.08, w * 0.60, h * 0.2, w * 0.16);
  ctx.fillStyle = 'rgba(35,70,130,.8)';
  ctx.fill();

  // Tavan çizgisi — hafif orta ayraç, "ileri" yönünü daha da netleştirir
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.08);
  ctx.lineTo(0, h * 0.06);
  ctx.strokeStyle = 'rgba(0,0,0,.15)';
  ctx.lineWidth = size * 0.012;
  ctx.stroke();

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
    if(!matchMap.hasImage(MATCH_CAR_IMAGE_ID)) matchMap.addImage(MATCH_CAR_IMAGE_ID, generateMatchCarImageData());
    matchDotImagesReady = true;
  }
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
