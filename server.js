const http = require('http');
const https = require('https');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const PORT = 3020;
const VCB_URL = 'https://ib.vietcombank.com.vn';

// ====== CẤU HÌNH TÀI KHOẢN ======
const CONFIG = {
    username: '0382962182',           // Số điện thoại đăng nhập
    password: 'Hoang28042010@',       // Mật khẩu (đã cập nhật)
    stk: '0382962182',                // Số tài khoản
    otp: '' // Để trống để nhập OTP thủ công
};

let browser = null;
let page = null;
let loggedIn = false;
let lastRefresh = 0;
let lastHistoryData = null;
let lastHistoryTime = 0;
let loginInProgress = false;
let captchaWorker = null;
let otpRequired = false;
let otpResolve = null;

// ====== KHỞI TẠO TESSERACT ======
async function initTesseract() {
    if (!captchaWorker) {
        captchaWorker = await createWorker('vie+eng');
        console.log('✅ Tesseract worker initialized');
    }
    return captchaWorker;
}

// ====== XỬ LÝ ẢNH CAPTCHA ======
async function preprocessCaptcha(imgBase64) {
    try {
        const imageBuffer = Buffer.from(imgBase64, 'base64');
        
        const processed = await sharp(imageBuffer)
            .greyscale()
            .normalize()
            .threshold(170)
            .sharpen(2, 1.5)
            .blur(0.5)
            .toBuffer();
        
        const variations = [
            await sharp(imageBuffer).greyscale().threshold(150).sharpen().toBuffer(),
            await sharp(imageBuffer).greyscale().threshold(180).sharpen().toBuffer(),
            await sharp(imageBuffer).greyscale().threshold(200).sharpen().toBuffer(),
            processed
        ];
        
        return variations.map(buf => buf.toString('base64'));
    } catch (error) {
        console.error('Lỗi tiền xử lý ảnh:', error);
        return [imgBase64];
    }
}

// ====== GIẢI CAPTCHA VCB ======
async function solveVCBCaptcha(imgBase64) {
    try {
        await initTesseract();
        const variations = await preprocessCaptcha(imgBase64);
        
        let bestResult = null;
        let highestConfidence = 0;
        
        for (const variant of variations) {
            const result = await captchaWorker.recognize(
                `data:image/png;base64,${variant}`
            );
            
            const text = result.data.text.trim()
                .replace(/\s/g, '')
                .replace(/[^a-zA-Z0-9]/g, '')
                .toUpperCase();
            
            const confidence = result.data.confidence || 0;
            
            console.log(`📊 Tesseract: "${text}" (${confidence}%)`);
            
            if (text.length >= 4 && confidence > highestConfidence) {
                highestConfidence = confidence;
                bestResult = text;
            }
        }
        
        if (bestResult && bestResult.length > 6) {
            bestResult = bestResult.substring(0, 6);
        }
        
        return bestResult;
    } catch (error) {
        console.error('Lỗi Tesseract:', error);
        return null;
    }
}

// ====== LẤY CAPTCHA ======
async function getVCBCaptcha() {
    try {
        const captcha = await page.evaluate(() => {
            const selectors = [
                '#captchaImg',
                '.captcha-img',
                'img[src*="captcha"]',
                'img[alt*="captcha"]',
                '#captchaImage',
                '.captcha-image'
            ];
            
            for (const selector of selectors) {
                const img = document.querySelector(selector);
                if (img && img.src) {
                    return img.src;
                }
            }
            
            const imgs = document.querySelectorAll('img');
            for (const img of imgs) {
                if (img.src && (img.src.includes('captcha') || img.alt?.includes('captcha'))) {
                    return img.src;
                }
            }
            
            return null;
        });
        
        if (captcha && captcha.startsWith('data:image')) {
            return captcha.replace(/^data:image\/\w+;base64,/, '');
        }
        
        if (captcha && captcha.startsWith('http')) {
            try {
                const response = await page.goto(captcha, { waitUntil: 'networkidle0', timeout: 10000 });
                const buffer = await response.buffer();
                return buffer.toString('base64');
            } catch (e) {
                console.log('⚠️ Không tải được captcha từ URL');
                return null;
            }
        }
        
        return null;
    } catch (error) {
        console.error('Lỗi lấy captcha VCB:', error);
        return null;
    }
}

// ====== RELOAD CAPTCHA ======
async function reloadVCBCaptcha() {
    try {
        const reloaded = await page.evaluate(() => {
            const img = document.querySelector('#captchaImg, .captcha-img, img[src*="captcha"]');
            if (img) {
                img.click();
                return true;
            }
            
            const reloadBtn = document.querySelector('.captcha-reload, .reload-captcha, button[onclick*="captcha"]');
            if (reloadBtn) {
                reloadBtn.click();
                return true;
            }
            
            return false;
        });
        
        if (reloaded) {
            await new Promise(r => setTimeout(r, 1000));
        }
        return reloaded;
    } catch (error) {
        console.error('Lỗi reload captcha:', error);
        return false;
    }
}

// ====== ĐĂNG NHẬP VCB ======
async function loginVCB() {
    if (loginInProgress) return { success: false, message: 'Đang login...' };
    loginInProgress = true;
    otpRequired = false;
    
    let maxRetries = 5;
    let attempt = 0;
    
    try {
        await initBrowser();
        console.log('📱 Mở Vietcombank...');
        
        await page.goto(VCB_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        
        const currentUrl = page.url();
        if (!currentUrl.includes('login')) {
            await page.evaluate(() => {
                const loginBtn = document.querySelector('.btn-login, #btnLogin, a[href*="login"]');
                if (loginBtn) loginBtn.click();
            });
            await new Promise(r => setTimeout(r, 3000));
        }
        
        console.log('🔑 Đang điền thông tin đăng nhập...');
        console.log(`👤 Username: ${CONFIG.username}`);
        
        await page.waitForSelector('#user-id, #username, input[name="username"], input[name="userId"]', { timeout: 10000 });
        await page.type('#user-id, #username, input[name="username"], input[name="userId"]', CONFIG.username, { delay: 10 });
        
        await page.type('#password, input[name="password"]', CONFIG.password, { delay: 10 });
        
        while (attempt < maxRetries) {
            attempt++;
            console.log(`🔄 Lần thử ${attempt}/${maxRetries}`);
            
            let captchaBase64 = await getVCBCaptcha();
            if (!captchaBase64) {
                console.log('⚠️ Không tìm thấy captcha, reload...');
                await reloadVCBCaptcha();
                await new Promise(r => setTimeout(r, 2000));
                captchaBase64 = await getVCBCaptcha();
                if (!captchaBase64) {
                    console.log('❌ Vẫn không tìm thấy captcha');
                    continue;
                }
            }
            
            console.log('🤖 Đang giải captcha...');
            const captchaText = await solveVCBCaptcha(captchaBase64);
            
            if (!captchaText || captchaText.length < 4) {
                console.log('⚠️ Không giải được captcha, reload...');
                await reloadVCBCaptcha();
                continue;
            }
            
            console.log(`📝 Nhập captcha: ${captchaText}`);
            
            const captchaInput = await page.$('#captcha, input[name="captcha"], input[placeholder*="Mã xác nhận"]');
            if (captchaInput) {
                await captchaInput.click({ clickCount: 3 });
                await captchaInput.type(captchaText, { delay: 10 });
            }
            
            console.log('🔄 Đang đăng nhập...');
            await page.click('#btnLogin, .btn-login, button[type="submit"], input[type="submit"]');
            await new Promise(r => setTimeout(r, 5000));
            
            const text = await page.evaluate(() => document.body.innerText);
            const url = page.url();
            
            if (text.includes('captcha không chính xác') || 
                text.includes('Mã xác nhận không đúng') ||
                text.includes('Invalid captcha')) {
                console.log('❌ Sai captcha, thử lại...');
                await reloadVCBCaptcha();
                continue;
            }
            
            if (text.includes('sai') || 
                text.includes('incorrect') || 
                text.includes('không đúng') ||
                text.includes('invalid username') ||
                text.includes('invalid password')) {
                throw new Error('Sai thông tin đăng nhập');
            }
            
            if (url.includes('otp') || 
                text.includes('mã xác thực') || 
                text.includes('OTP') ||
                text.includes('Xác thực hai yếu tố')) {
                console.log('🔐 Yêu cầu nhập OTP');
                otpRequired = true;
                
                if (CONFIG.otp) {
                    console.log(`📝 Nhập OTP: ${CONFIG.otp}`);
                    await page.type('#otp, input[name="otp"], input[placeholder*="OTP"]', CONFIG.otp, { delay: 10 });
                    await page.click('#btnConfirm, .btn-confirm, button[type="submit"]');
                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    console.log('⏳ VUI LÒNG NHẬP OTP THỦ CÔNG (60s)...');
                    console.log('📌 Gửi POST /api/otp với body: {"otp": "your_otp"}');
                    
                    const otpCode = await waitForOTP(60000);
                    if (otpCode) {
                        console.log(`📝 Nhập OTP: ${otpCode}`);
                        await page.type('#otp, input[name="otp"], input[placeholder*="OTP"]', otpCode, { delay: 10 });
                        await page.click('#btnConfirm, .btn-confirm, button[type="submit"]');
                        await new Promise(r => setTimeout(r, 3000));
                    } else {
                        throw new Error('Timeout chờ OTP');
                    }
                }
            }
            
            const finalUrl = page.url();
            if (finalUrl.includes('dashboard') || 
                finalUrl.includes('home') || 
                finalUrl.includes('account') ||
                finalUrl.includes('overview')) {
                loggedIn = true;
                lastRefresh = Date.now();
                otpRequired = false;
                console.log('✅ Đăng nhập VCB thành công!');
                return { success: true };
            }
            
            if (finalUrl.includes('login') || finalUrl.includes('auth')) {
                console.log('🔄 Vẫn ở trang login, thử lại...');
                continue;
            }
        }
        
        throw new Error(`Không thể đăng nhập sau ${maxRetries} lần thử`);
        
    } catch(e) {
        console.log('❌ Login failed:', e.message);
        throw e;
    } finally {
        loginInProgress = false;
    }
}

// ====== CHỜ OTP ======
function waitForOTP(timeout = 60000) {
    return new Promise((resolve) => {
        otpResolve = resolve;
        setTimeout(() => {
            if (otpResolve) {
                otpResolve(null);
                otpResolve = null;
            }
        }, timeout);
    });
}

// ====== LẤY LỊCH SỬ GIAO DỊCH VCB ======
async function getVCBHistory() {
    if (!loggedIn || !page) throw new Error('Chưa login');
    
    try {
        console.log('📊 Đang lấy lịch sử giao dịch...');
        
        await page.goto(`${VCB_URL}/account/statement`, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        
        const url = page.url();
        if (url.includes('login')) {
            loggedIn = false;
            throw new Error('Session đã hết hạn');
        }
        
        try {
            await page.select('#accountId, select[name="account"], .account-select', CONFIG.stk);
            await new Promise(r => setTimeout(r, 1000));
        } catch(e) {
            console.log('⚠️ Không chọn được tài khoản, thử cách khác...');
        }
        
        const today = new Date();
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);
        
        const formatDate = (date) => {
            const d = date.getDate().toString().padStart(2, '0');
            const m = (date.getMonth() + 1).toString().padStart(2, '0');
            const y = date.getFullYear();
            return `${d}/${m}/${y}`;
        };
        
        await page.evaluate((from, to) => {
            const fromInput = document.querySelector('#fromDate, input[name="fromDate"], input[placeholder*="Từ ngày"]');
            const toInput = document.querySelector('#toDate, input[name="toDate"], input[placeholder*="Đến ngày"]');
            if (fromInput) fromInput.value = from;
            if (toInput) toInput.value = to;
        }, formatDate(thirtyDaysAgo), formatDate(today));
        
        await page.click('#btnSearch, .btn-search, button[type="submit"], .search-btn');
        await new Promise(r => setTimeout(r, 5000));
        
        const data = await page.evaluate(() => {
            const items = [];
            const rows = document.querySelectorAll('table tbody tr, .transaction-row, .data-row');
            
            rows.forEach(row => {
                const cells = row.querySelectorAll('td, .col, .cell');
                if (cells.length >= 3) {
                    items.push({
                        date: cells[0]?.textContent?.trim() || '',
                        description: cells[1]?.textContent?.trim() || '',
                        amount: cells[2]?.textContent?.trim() || '',
                        balance: cells[3]?.textContent?.trim() || '',
                    });
                }
            });
            
            let balance = '';
            const balanceSelectors = [
                '.balance',
                '.account-balance',
                '.current-balance',
                '.available-balance',
                '.sodu'
            ];
            
            for (const selector of balanceSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    balance = el.textContent.trim().replace(/[^0-9]/g, '');
                    break;
                }
            }
            
            if (!balance) {
                const text = document.body.innerText;
                const match = text.match(/(?:Số dư|Dư nợ|Số dư khả dụng|Available Balance)[:\s]*([\d.,]+)/i);
                if (match) {
                    balance = match[1].replace(/\./g, '').replace(/,/g, '');
                }
            }
            
            return { items, balance };
        });
        
        const tranList = data.items.map(item => {
            const amountStr = item.amount.replace(/[^0-9-]/g, '');
            const isCredit = !amountStr.startsWith('-');
            const amount = Math.abs(parseInt(amountStr) || 0);
            
            return {
                refNo: Date.now().toString() + Math.random().toString(36).substring(7),
                tranId: Date.now().toString() + Math.random().toString(36).substring(7),
                postingDate: item.date,
                transactionDate: item.date,
                accountNo: CONFIG.stk,
                amount: isCredit ? `+${amount}` : `-${amount}`,
                creditAmount: isCredit ? String(amount) : '0',
                debitAmount: isCredit ? '0' : String(amount),
                currency: 'VND',
                description: item.description,
                availableBalance: data.balance || '0',
                beneficiaryAccount: '',
            };
        });
        
        lastHistoryData = {
            status: 'success',
            message: 'Thành công',
            availableBalance: data.balance || '0',
            TranList: tranList,
            timestamp: new Date().toISOString()
        };
        lastHistoryTime = Date.now();
        
        console.log(`✅ Lấy được ${tranList.length} giao dịch`);
        return lastHistoryData;
        
    } catch(e) {
        console.error('Lỗi lấy lịch sử:', e.message);
        if (e.message.includes('Session') || e.message.includes('login')) {
            loggedIn = false;
        }
        throw e;
    }
}

// ====== KHỞI TẠO BROWSER ======
async function initBrowser() {
    if (browser && page) return;
    if (browser) {
        try { await browser.close(); } catch(e) {}
    }
    
    console.log('🚀 Khởi tạo trình duyệt...');
    browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-default-apps',
            '--disable-translate',
            '--disable-features=TranslateUI'
        ]
    });
    
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'vi-VN,vi;q=0.9'
    });
    
    browser.on('disconnected', () => {
        loggedIn = false;
        browser = null;
        page = null;
        console.log('⚠️ Browser disconnected');
    });
}

// ====== SERVER ======
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    
    try {
        if (path === '/api/status') {
            return res.end(JSON.stringify({
                status: loggedIn ? 'logged_in' : 'not_logged_in',
                bank: 'Vietcombank',
                stk: CONFIG.stk,
                username: CONFIG.username,
                otp_required: otpRequired,
                session_age: loggedIn ? Math.round((Date.now() - lastRefresh) / 1000) + 's' : null,
                history_age: lastHistoryData ? Math.round((Date.now() - lastHistoryTime) / 1000) + 's' : null,
                timestamp: new Date().toISOString()
            }));
        }
        
        if (path === '/api/login') {
            const result = await loginVCB();
            res.writeHead(200);
            return res.end(JSON.stringify(result));
        }
        
        if (path === '/api/otp' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const otp = data.otp;
                    if (otp && otpResolve) {
                        otpResolve(otp);
                        otpResolve = null;
                        res.end(JSON.stringify({ success: true, message: 'OTP received' }));
                    } else {
                        res.end(JSON.stringify({ success: false, message: 'No OTP waiting or invalid OTP' }));
                    }
                } catch(e) {
                    res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
                }
            });
            return;
        }
        
        if (path === '/api/history') {
            if (lastHistoryData && (Date.now() - lastHistoryTime) < 30000) {
                return res.end(JSON.stringify(lastHistoryData));
            }
            if (!loggedIn) {
                console.log('🔄 Session expired, auto-login...');
                await loginVCB();
            }
            const result = await getVCBHistory();
            res.writeHead(200);
            return res.end(JSON.stringify(result));
        }
        
        if (path === '/api/logout') {
            if (page) {
                await page.goto(`${VCB_URL}/logout`, { waitUntil: 'networkidle2' });
            }
            loggedIn = false;
            return res.end(JSON.stringify({ success: true, message: 'Logged out' }));
        }
        
        res.writeHead(200);
        res.end(JSON.stringify({
            name: 'Vietcombank API',
            version: '2.0',
            bank: 'Vietcombank',
            endpoints: [
                '/api/status - Kiểm tra trạng thái',
                '/api/login - Đăng nhập',
                '/api/otp - Gửi OTP (POST)',
                '/api/history - Lấy lịch sử giao dịch',
                '/api/logout - Đăng xuất'
            ],
            config: {
                username: CONFIG.username,
                stk: CONFIG.stk,
                otp_auto: CONFIG.otp ? true : false
            },
            note: 'Nếu cần OTP, gửi POST /api/otp với body {"otp": "your_otp"}'
        }));
        
    } catch(e) {
        console.error('Server error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ 
            status: 'error', 
            message: e.message
        }));
    }
});

// ====== KHỞI ĐỘNG SERVER ======
server.listen(PORT, '0.0.0.0', async () => {
    console.log('='.repeat(60));
    console.log(`🚀 VIETCOMBANK API SERVER`);
    console.log('='.repeat(60));
    console.log(`📡 Địa chỉ: http://0.0.0.0:${PORT}`);
    console.log(`🏦 Ngân hàng: Vietcombank`);
    console.log(`👤 Username: ${CONFIG.username}`);
    console.log(`💳 Số TK: ${CONFIG.stk}`);
    console.log(`🔐 OTP Auto: ${CONFIG.otp ? 'CÓ' : 'KHÔNG (phải nhập thủ công)'}`);
    console.log('='.repeat(60));
    
    console.log('🔄 Khởi tạo Tesseract...');
    await initTesseract();
    console.log('✅ Tesseract ready');
    
    console.log('📡 Đang đăng nhập lần đầu...');
    try {
        await loginVCB();
        console.log('✅ Server sẵn sàng!');
    } catch(e) {
        console.log('⚠️ Lỗi đăng nhập ban đầu:', e.message);
        console.log('📌 Server vẫn đang chạy, sẽ tự động đăng nhập khi có request');
    }
    console.log('='.repeat(60));
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Đang tắt server...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Đang tắt server...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});
