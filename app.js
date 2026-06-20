// ==========================================
// 1. FIREBASE BAĞLANTI AYARLARI
// ==========================================
const firebaseConfig = {
    databaseURL: "https://chat-ee35e-default-rtdb.europe-west1.firebasedatabase.app/",
    storageBucket: "chat-ee35e.appspot.com"
};

// Eğer Firebase henüz başlatılmamışsa başlat
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const database = firebase.database();
const storage = firebase.storage();

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
        msgSending: "Kod gönderiliyor...",
        msgSuccessCode: "Kod başarıyla doğrulandı! Yönlendiriliyorsunuz...",
        msgLoginSuccess: "Giriş başarılı! Yönlendiriliyorsunuz..."
    },
    en: {
        langLbl: "TR",
        txtHeroDesc: "Welcome to the website of the future. Please turn on the lamp and register if you don't have an account, or log in.",
        errFields: "Please fill in all fields completely!",
        errCodeWrong: "Invalid or incomplete verification code!",
        msgSending: "Sending code...",
        msgSuccessCode: "Code verified successfully! Redirecting...",
        msgLoginSuccess: "Login successful! Redirecting..."
    }
};

// ==========================================
// 3. TEMA VE DİL SİSTEMİ FONKSİYONLARI
// ==========================================
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    let newTheme = (currentTheme === 'light') ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('site_theme', newTheme);
    
    // Temaya göre buton ve logoları ayarla
    document.querySelectorAll('.theme-toggle-corner').forEach(btn => {
        btn.textContent = (newTheme === 'light') ? '☀️' : '🌙';
    });
    
    const logoImg = document.getElementById('siteLogo');
    if (logoImg) {
        logoImg.src = (newTheme === 'light') ? 'siyah_logo.PNG' : 'beyaz_logo.PNG';
    }
}

function toggleLanguage() {
    currentLanguage = (currentLanguage === 'tr') ? 'en' : 'tr';
    localStorage.setItem('site_lang', currentLanguage);
    applyLanguage();
}

function applyLanguage() {
    const data = translations[currentLanguage];
    const lbls = document.querySelectorAll('.lang-lbl');
    lbls.forEach(el => el.textContent = data.langLbl);
    
    const desc = document.getElementById('txtHeroDesc');
    if (desc) desc.textContent = data.txtHeroDesc;
}

// Sayfa ilk yüklendiğinde tema ve dili geri yükle
window.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('site_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedTheme === 'light' && document.getElementById('siteLogo')) {
        document.getElementById('siteLogo').src = 'siyah_logo.PNG';
    }
    applyLanguage();
});

// ==========================================
// 4. ABAJUR LAMBA MOTORU
// ==========================================
function pullLampChain() {
    const lamp = document.getElementById('mainLamp');
    const startStep = document.getElementById('startStep');
    const loginStep = document.getElementById('loginStep');
    
    isLampOn = !isLampOn;
    
    if (isLampOn) {
        lamp.classList.add('on');
        if(startStep) startStep.style.display = 'none';
        if(loginStep) loginStep.style.display = 'block';
    } else {
        lamp.classList.remove('on');
        if(startStep) startStep.style.display = 'block';
        if(loginStep) loginStep.style.display = 'none';
        document.getElementById('registerStep').style.display = 'none';
        document.getElementById('verificationStep').style.display = 'none';
    }
}

function switchStep(nextStepId) {
    document.getElementById('loginStep').style.display = 'none';
    document.getElementById('registerStep').style.display = 'none';
    document.getElementById('verificationStep').style.display = 'none';
    
    document.getElementById(nextStepId).style.display = 'block';
    showStatus("", "");
}

function togglePasswordVisibility(inputId, button) {
    const input = document.getElementById(inputId);
    const icon = button.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fa-solid fa-eye';
    } else {
        input.type = 'password';
        icon.className = 'fa-solid fa-eye-slash';
    }
}

function showStatus(text, color) {
    const msgBox = document.getElementById('statusMessage');
    if(!msgBox) return;
    msgBox.textContent = text;
    msgBox.style.color = color || 'inherit';
}

// ==========================================
// 5. KIMLİK DOĞRULAMA (AUTH) İŞLEMLERİ
// ==========================================
let tempRegData = null; // Doğrulama öncesi kayıt bilgilerini geçici tutar

function handleRegister() {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    
    if(!username || !email || !password) {
        showStatus(translations[currentLanguage].errFields, '#ff4d4d');
        return;
    }
    
    showStatus(translations[currentLanguage].msgSending, '#ff9f43');
    
    // Kullanıcı adının benzersiz olup olmadığını kontrol et
    database.ref('users').orderByChild('username').equalTo(username).once('value', snapshot => {
        if (snapshot.exists()) {
            showStatus("Bu kullanıcı adı zaten alınmış!", '#ff4d4d');
        } else {
            // 6 Haneli Doğrulama Kodu Oluştur (Simüle edilmiş güvenli e-posta doğrulama yapısı)
            const generatedCode = String(Math.floor(100000 + Math.random() * 900000));
            
            tempRegData = { username, email, password, code: generatedCode };
            
            // Gerçek projede kod veritabanında doğrulanmak üzere bekletilir
            database.ref(`temp_verifications/${username}`).set({
                email: email,
                code: generatedCode,
                timestamp: Date.now()
            }).then(() => {
                // Kodu konsola yazdırıyoruz (Geliştirme ve test kolaylığı için kolayca görebilirsin)
                console.log(`[Talha Web Platform] E-posta doğrulama kodu gönderildi: ${generatedCode}`);
                alert(`Doğrulama kodunuz e-postanıza simüle edildi!\nKod: ${generatedCode}`);
                
                switchStep('verificationStep');
            });
        }
    });
}

function handleVerifyCode() {
    const inputCode = document.getElementById('verificationCode').value.trim();
    
    if(!tempRegData || inputCode !== tempRegData.code) {
        showStatus(translations[currentLanguage].errCodeWrong, '#ff4d4d');
        return;
    }
    
    showStatus(translations[currentLanguage].msgSuccessCode, '#28a745');
    
    // Firebase Yerel Auth Kaydını ve profil tablosunu oluştur
    const cleanEmail = tempRegData.email.toLowerCase().replace('.', '_');
    
    database.ref(`users/${cleanEmail}`).set({
        username: tempRegData.username,
        email: tempRegData.email,
        password: tempRegData.password, // Admin paneli denetimi için şifreyi db'ye işliyoruz
        avatar: "", // Profil resmi başlangıçta boş
        role: (tempRegData.username.toLowerCase() === 'admin') ? 'admin' : 'user'
    }).then(() => {
        // Oturum açma bilgisi olarak tarayıcı hafızasını güncelle
        sessionStorage.setItem('active_user_email', tempRegData.email);
        sessionStorage.setItem('active_user_name', tempRegData.username);
        
        setTimeout(() => {
            window.location.href = 'verify.html';
        }, 1500);
    });
}

function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    
    if(!email || !password) {
        showStatus(translations[currentLanguage].errFields, '#ff4d4d');
        return;
    }
    
    const cleanEmail = email.toLowerCase().replace('.', '_');
    
    database.ref(`users/${cleanEmail}`).once('value', snapshot => {
        if(snapshot.exists()) {
            const userData = snapshot.val();
            if(userData.password === password) {
                showStatus(translations[currentLanguage].msgLoginSuccess, '#28a745');
                
                sessionStorage.setItem('active_user_email', userData.email);
                sessionStorage.setItem('active_user_name', userData.username);
                
                setTimeout(() => {
                    window.location.href = 'verify.html';
                }, 1200);
            } else {
                showStatus("Hatalı şifre girdiniz!", '#ff4d4d');
            }
        } else {
            showStatus("Bu e-posta adresine ait kullanıcı bulunamadı!", '#ff4d4d');
        }
    });
}
