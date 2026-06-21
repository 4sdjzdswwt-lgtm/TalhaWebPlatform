// ==========================================
// 1. FIREBASE BAĞLANTI AYARLARI (GÜNCELLENDİ)
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyCsGmCLBb0cqpnHrcn66PIHhIr5RSaRSFY",
    authDomain: "talhaweb-c5e40.firebaseapp.com",
    projectId: "talhaweb-c5e40",
    storageBucket: "talhaweb-c5e40.firebasestorage.app",
    messagingSenderId: "286141336960",
    appId: "1:286141336960:web:92e80c38865665d6b80565",
    measurementId: "G-T5147XWHL5",
    databaseURL: "https://chat-ee35e-default-rtdb.europe-west1.firebasedatabase.app/"
};

// Eğer Firebase henüz başlatılmamışsa başlat
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const database = firebase.database();
const storage = firebase.storage();
const googleProvider = new firebase.auth.GoogleAuthProvider();

// ==========================================
// 2. GLOBAL DEĞİŞKENLER VE DİL MOTORU
// ==========================================
let isLampOn = false;
let currentLanguage = localStorage.getItem('site_lang') || 'tr';

const translations = {
    tr: {
        langLbl: "EN",
        txtHeroDesc: "Hoş geldiniz, geleceğin web sitesine. Lütfen abajuru açtıktan sonra hesabınız yoksa kaydolun varsa giriş yapınız.",
        errFields: "Lütfen tüm alanları eksiksiz doldurun!",
        errCodeWrong: "Hatalı veya eksik doğrulama kodu!",
        msgSending: "İşlem yapılıyor...",
        msgSuccessCode: "Başarıyla giriş yapıldı! Yönlendiriliyorsunuz...",
        msgLoginSuccess: "Giriş başarılı! Yönlendiriliyorsunuz..."
    },
    en: {
        langLbl: "TR",
        txtHeroDesc: "Welcome to the website of the future. Please turn on the lamp and register if you don't have an account, or login if you do.",
        errFields: "Please fill in all fields completely!",
        errCodeWrong: "Incorrect or missing verification code!",
        msgSending: "Processing...",
        msgSuccessCode: "Successfully logged in! Redirecting...",
        msgLoginSuccess: "Login successful! Redirecting..."
    }
};

// TEMA GİFLERİ LİSTESİ (Sizin seçtiğiniz hareketli arka planlar)
const themeGifs = [
    'https://i.pinimg.com/originals/ba/8e/3c/ba8e3c15b991da0733cb17f699042b4d.gif',
    'https://i.pinimg.com/originals/5d/43/6e/5d436e2fbd6d0ef0413009fa3e764491.gif',
    'https://i.pinimg.com/originals/60/a4/be/60a4be3524b8159d33b207dfecbc0213.gif',
    'https://i.pinimg.com/originals/ef/95/43/ef954316688755b7da03ef2de405bc7f.gif',
    'https://i.pinimg.com/originals/cf/14/08/cf1408ccb416be70e30206103b41d2f8.gif',
    'https://i.pinimg.com/originals/ef/47/43/ef47432eb4a148f3254cb6b0a7b454e9.gif',
    'https://i.pinimg.com/originals/bd/06/f0/bd06f0e69d3000b0805d7b5ec1e604f8.gif',
    'https://i.pinimg.com/originals/e4/c7/ee/e4c7ee2db649e3bf32db4d3f54bf692f.gif',
    'https://i.pinimg.com/originals/2c/45/c0/2c45c08000456c6ffc5d57b545465f24.gif',
    'https://i.pinimg.com/originals/f5/01/29/f50129e9cbca7ee09e43681498e5e6e6.gif',
    'https://i.pinimg.com/originals/29/73/0e/29730e1bc03e3a96860dbbf26bc6936c.gif',
    'https://i.pinimg.com/originals/65/56/a0/6556a0df0b8ca8131e5e0cf79ffb698c.gif'
];
let currentThemeIndex = parseInt(localStorage.getItem('talha_theme_idx')) || 0;

// ==========================================
// 3. SAYFA YÜKLENİNCE ÇALIŞAN MOTORLAR
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    applyLanguage(currentLanguage);
    applyTheme(currentThemeIndex);

    // Google Butonlarını HTML dosyasına dokunmadan dinamik olarak ekliyoruz
    injectGoogleButtons();
});

// ==========================================
// 4. TEMEL FONKSİYONLAR (LAMBA VE TEMA AYARLARI)
// ==========================================
function toggleLanguage() {
    currentLanguage = currentLanguage === 'tr' ? 'en' : 'tr';
    localStorage.setItem('site_lang', currentLanguage);
    applyLanguage(currentLanguage);
}

function applyLanguage(lang) {
    const btn = document.getElementById('langToggleBtn');
    if(btn) btn.innerText = translations[lang].langLbl;
    
    const desc = document.getElementById('heroDescription');
    if(desc) desc.innerText = translations[lang].txtHeroDesc;
}

function nextTheme() {
    currentThemeIndex = (currentThemeIndex + 1) % themeGifs.length;
    localStorage.setItem('talha_theme_idx', currentThemeIndex);
    applyTheme(currentThemeIndex);
}

function applyTheme(index) {
    const bgLayer = document.getElementById('gifBgLayer');
    if(bgLayer) {
        bgLayer.style.backgroundImage = `url('${themeGifs[index]}')`;
    }
}

function showStatus(text, color) {
    const box = document.getElementById('statusMessageBox');
    if(box) {
        box.innerText = text;
        box.style.background = color;
        box.style.display = 'block';
        setTimeout(() => { box.style.display = 'none'; }, 4000);
    }
}

// ==========================================
// 5. FIREBASE AUTHENTICATION MOTORLARI
// ==========================================

// GİRİŞ YAPMA MOTORU
function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    
    if(!email || !password) {
        showStatus(translations[currentLanguage].errFields, '#ff4d4d');
        return;
    }
    
    showStatus(translations[currentLanguage].msgSending, '#3a3b3c');

    // Gerçek Firebase Giriş Metodu
    auth.signInWithEmailAndPassword(email, password)
        .then((userCredential) => {
            const user = userCredential.user;
            showStatus(translations[currentLanguage].msgLoginSuccess, '#28a745');
            
            sessionStorage.setItem('active_user_email', user.email);
            sessionStorage.setItem('active_user_name', user.email.split('@')[0]);
            
            setTimeout(() => {
                window.location.href = 'feed.html'; // Doğrudan akış sayfasına gider
            }, 1200);
        })
        .catch((error) => {
            showStatus("Giriş Başarısız: " + error.message, '#ff4d4d');
        });
}

// KAYIT OLMA MOTORU
function handleRegister() {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    
    if(!username || !email || !password) {
        showStatus(translations[currentLanguage].errFields, '#ff4d4d');
        return;
    }

    if(password.length < 6) {
        showStatus("Şifre en az 6 karakter olmalıdır!", '#ff4d4d');
        return;
    }

    showStatus(translations[currentLanguage].msgSending, '#3a3b3c');

    // Gerçek Firebase Kayıt Metodu
    auth.createUserWithEmailAndPassword(email, password)
        .then((userCredential) => {
            const user = userCredential.user;
            
            // Kullanıcı adını Realtime Database'e kaydeder
            const cleanEmail = email.toLowerCase().replace(/\./g, '_');
            database.ref(`users/${cleanEmail}`).set({
                username: username,
                email: email,
                createdAt: firebase.database.ServerValue.TIMESTAMP
            });

            showStatus("Hesabınız oluşturuldu! Giriş yapılıyor...", '#28a745');
            
            sessionStorage.setItem('active_user_email', user.email);
            sessionStorage.setItem('active_user_name', username);
            
            setTimeout(() => {
                window.location.href = 'feed.html';
            }, 1500);
        })
        .catch((error) => {
            showStatus("Kayıt Hatası: " + error.message, '#ff4d4d');
        });
}

// GOOGLE İLE GİRİŞ YAPMA MOTORU
function handleGoogleLogin() {
    auth.signInWithPopup(googleProvider)
        .then((result) => {
            const user = result.user;
            showStatus("Google ile başarıyla giriş yapıldı!", '#28a745');
            
            sessionStorage.setItem('active_user_email', user.email);
            sessionStorage.setItem('active_user_name', user.displayName || user.email.split('@')[0]);
            
            setTimeout(() => {
                window.location.href = 'feed.html';
            }, 1200);
        })
        .catch((error) => {
            showStatus("Google Giriş Hatası: " + error.message, '#ff4d4d');
        });
}

// Tasarımınızı bozmamak için butonları kodla otomatik olarak yerleştiriyoruz
function injectGoogleButtons() {
    const createGoogleBtn = (id) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = 'btn btn-secondary';
        btn.style.marginTop = '12px';
        btn.style.background = '#ffffff';
        btn.style.color = '#000000';
        btn.innerHTML = `<img src="https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg" alt="G" width="16" style="margin-right:8px; vertical-align:middle;"> Google ile Devam Et`;
        btn.addEventListener('click', handleGoogleLogin);
        return btn;
    };

    // Giriş formunun altına yerleştir
    const loginStepBox = document.getElementById('loginStep');
    if (loginStepBox) {
        const form = loginStepBox.querySelector('.auth-form');
        if (form) form.appendChild(createGoogleBtn('googleLoginBtn1'));
    }

    // Kayıt formunun altına yerleştir
    const registerStepBox = document.getElementById('registerStep');
    if (registerStepBox) {
        const form = registerStepBox.querySelector('.auth-form');
        if (form) form.appendChild(createGoogleBtn('googleLoginBtn2'));
    }
}
