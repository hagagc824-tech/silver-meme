const http = require('http');
const puppeteer = require('puppeteer');
const chromium = require('@sparticuz/chromium');

const PORT = process.env.PORT || 3020;

// ====== CẤU HÌNH TÀI KHOẢN VCB ======
const CONFIG = {
    username: '0382962182',
    password: 'Hoang28042010@',
    stk: '0382962182'
};

let browser = null;
let page = null;
let loggedIn = false;
let lastHistoryData = null;
let lastHistoryTime = 0;

// ====== KHỞI TẠO BROWSER CHO RENDER ======
async function initBrowser() {
    if (browser && page) return;
    if (browser) {
        try { await browser.close(); } catch(e) {}
    }
    
    console.log('🚀 Khởi tạo trình duyệt...');
    
    browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080'
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
    
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    browser.on('disconnected', () => {
        loggedIn = false;
        browser = null;
        page = null;
        console.log('⚠️ Browser disconnected');
    });
}

// ====== ĐĂNG NHẬP VCB ======
async function loginVCB() {
    try {
        await initBrowser();
        console.log('📱 Đang đăng nhập VCB...');
        
        await page.goto('https://ib.vietcombank.com.vn', { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });
        
        await new Promise(r => setTimeout(r, 3000));
        
        // Click vào nút đăng nhập nếu có
        await page.evaluate(() => {
            const loginBtn = document.querySelector('.btn-login, #btnLogin, a[href*="login"]');
            if (loginBtn) loginBtn.click();
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        // Nhập username
        await page.waitForSelector('#user-id, #username, input[name="username"]', { timeout: 10000 });
        await page.type('#user-id, #username, input[name="username"]', CONFIG.username, { delay: 10 });
        
        // Nhập password
        await page.type('#password, input[name="password"]', CONFIG.password, { delay: 10 });
        
        // Click đăng nhập
        await page.click('#btnLogin, .btn-login, button[type="submit"]');
        await new Promise(r => setTimeout(r, 5000));
        
        const url = page.url();
        if (url.includes('dashboard') || url.includes('home') || url.includes('account')) {
            loggedIn = true;
            console.log('✅ Đăng nhập VCB thành công!');
            return { success: true };
        }
        
        return { success: false, message: 'Đăng nhập thất bại' };
        
    } catch(e) {
        console.log('❌ Login failed:', e.message);
        return { success: false, message: e.message };
    }
}

// ====== LẤY LỊCH SỬ GIAO DỊCH ======
async function getVCBHistory() {
    if (!loggedIn || !page) {
        await loginVCB();
        if (!loggedIn) throw new Error('Không thể đăng nhập');
    }
    
    try {
        console.log('📊 Đang lấy lịch sử giao dịch...');
        
        await page.goto('https://ib.vietcombank.com.vn/account/statement', { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });
        
        await new Promise(r => setTimeout(r, 3000));
        
        // Lấy dữ liệu
        const data = await page.evaluate(() => {
            const items = [];
            const rows = document.querySelectorAll('table tbody tr');
            
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    items.push({
                        date: cells[0]?.textContent?.trim() || '',
                        description: cells[1]?.textContent?.trim() || '',
                        amount: cells[2]?.textContent?.trim() || '',
                        balance: cells[3]?.textContent?.trim() || ''
                    });
                }
            });
            
            let balance = '';
            const balanceEl = document.querySelector('.balance, .account-balance');
            if (balanceEl) {
                balance = balanceEl.textContent.trim().replace(/[^0-9]/g, '');
            }
            
            return { items, balance };
        });
        
        lastHistoryData = {
            status: 'success',
            message: 'Thành công',
            availableBalance: data.balance || '0',
            TranList: data.items,
            timestamp: new Date().toISOString()
        };
        lastHistoryTime = Date.now();
        
        console.log(`✅ Lấy được ${data.items.length} giao dịch`);
        return lastHistoryData;
        
    } catch(e) {
        console.error('Lỗi lấy lịch sử:', e.message);
        throw e;
    }
}

// ====== SERVER ======
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const path = url.pathname;
        
        // API STATUS
        if (path === '/api/status') {
            res.end(JSON.stringify({
                status: loggedIn ? 'logged_in' : 'not_logged_in',
                bank: 'Vietcombank',
                username: CONFIG.username,
                stk: CONFIG.stk,
                timestamp: new Date().toISOString()
            }));
            return;
        }
        
        // API LOGIN
        if (path === '/api/login') {
            const result = await loginVCB();
            res.end(JSON.stringify(result));
            return;
        }
        
        // API HISTORY
        if (path === '/api/history') {
            if (lastHistoryData && (Date.now() - lastHistoryTime) < 30000) {
                res.end(JSON.stringify(lastHistoryData));
                return;
            }
            const result = await getVCBHistory();
            res.end(JSON.stringify(result));
            return;
        }
        
        // DEFAULT
        res.end(JSON.stringify({
            name: 'Vietcombank API',
            version: '2.0',
            endpoints: ['/api/status', '/api/login', '/api/history'],
            config: {
                username: CONFIG.username,
                stk: CONFIG.stk
            }
        }));
        
    } catch(e) {
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
    console.log(`👤 Username: ${CONFIG.username}`);
    console.log(`💳 Số TK: ${CONFIG.stk}`);
    console.log('='.repeat(60));
    
    console.log('🔄 Khởi tạo trình duyệt...');
    try {
        await initBrowser();
        console.log('✅ Browser ready');
        
        console.log('📡 Đang đăng nhập lần đầu...');
        await loginVCB();
    } catch(e) {
        console.log('⚠️ Lỗi:', e.message);
    }
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Đang tắt server...');
    if (browser) await browser.close();
    process.exit(0);
});
