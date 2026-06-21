const cheerio = require('cheerio');
const axios   = require('axios');

const BASE     = 'https://generator.email/';
const VALIDATE = 'check_adres_validation3.php';
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache'
};

class HttpClient {
  constructor() {
    this._cookie = '';
    this.client  = axios.create({ timeout: 20000, maxRedirects: 5, validateStatus: s => s >= 200 && s < 400 });
  }
  async fetch(url, opts = {}) {
    for (let i = 0; i < 4; i++) {
      try {
        const headers = { ...HEADERS, ...opts.headers };
        if (this._cookie) headers['Cookie'] = this._cookie;
        const res = await this.client({ url, method: opts.method || 'GET', headers, data: opts.body || null, responseType: 'text' });
        this._handleCookie(res);
        if (opts._raw) return res.data;
        try { return JSON.parse(res.data); } catch { return res.data; }
      } catch (err) {
        if (i === 3) throw new Error(err.response ? `HTTP ${err.response.status}` : err.message);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  _handleCookie(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    const m = sc.join(';').match(/surl=([^;]+)/);
    if (m) this._cookie = `surl=${m[1]}`;
  }
}

class EmailGenerator {
  constructor() { this.http = new HttpClient(); }

  async _validate(user, domain) {
    const p = new URLSearchParams({ usr: user, dmn: domain });
    return this.http.fetch(BASE + VALIDATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString()
    }).catch(() => ({}));
  }

  async generate(domain = '') {
    try {
      await this.http.fetch(domain ? BASE + domain : BASE, { _raw: true });
      const html  = await this.http.fetch(BASE, { _raw: true });
      const $     = cheerio.load(html);
      const email = $('#email_ch_text').text()?.trim();
      if (!email) return { success: false, result: 'Elemen email tidak ditemukan di halaman generator.email' };
      const [user, dm] = email.split('@');
      const val = await this._validate(user, dm);
      return { success: true, result: { email, emailStatus: val?.status || null } };
    } catch (e) { return { success: false, result: e.message }; }
  }

  async getInbox(email) {
    if (!email?.includes('@')) return { success: false, result: 'Email tidak valid' };
    const [user, domain] = email.split('@');
    const cookieVal = `surl=${domain}/${user}`;
    let html;
    try {
      html = await this.http.fetch(BASE, { headers: { Cookie: cookieVal }, _raw: true });
    } catch (e) { return { success: true, result: { email, inbox: [], error: e.message } }; }
    if (html.includes('Email generator is ready')) return { success: true, result: { email, inbox: [] } };
    const $     = cheerio.load(html);
    const count = parseInt($('#mess_number').text()) || 0;
    const inbox = [];
    if (count === 1) inbox.push(this._parseSingle($));
    else if (count > 1) inbox.push(...(await this._parseMultiple($)));
    return { success: true, result: { email, inbox } };
  }

  _parseSingle($) {
    const el    = $('#email-table .e7m.row');
    const spans = el.find('.e7m.col-md-9 span');
    return {
      from:    spans.eq(3).text().replace(/\(.*?\)/, '').trim(),
      to:      spans.eq(1).text(),
      created: el.find('.e7m.tooltip').text().replace('Created: ', ''),
      subject: el.find('h1').text(),
      message: el.find('.e7m.mess_bodiyy').text().trim(),
      links:   this._links($, '.e7m.mess_bodiyy')
    };
  }

  async _parseMultiple($) {
    const msgs  = [];
    const hrefs = $('#email-table a').map((_, a) => $(a).attr('href')).get();
    for (const href of hrefs) {
      try {
        const html = await this.http.fetch(BASE + href, {
          headers: { Cookie: `surl=${href.replace('/', '')}` }, _raw: true
        });
        const $m = cheerio.load(html);
        const sp = $m('.e7m.col-md-9 span');
        msgs.push({
          from:    sp.eq(3).text().replace(/\(.*?\)/, '').trim(),
          to:      sp.eq(1).text(),
          created: $m('.e7m.tooltip').text().replace('Created: ', ''),
          subject: $m('h1').text(),
          message: $m('.e7m.mess_bodiyy').text().trim(),
          links:   this._links($m, '.e7m.mess_bodiyy')
        });
      } catch (_) {}
    }
    return msgs;
  }

  _links($, sel) {
    const out = [];
    $(`${sel} a`).each((_, el) => {
      let h = $(el).attr('href');
      if (h) { if (!h.startsWith('http')) h = new URL(h, BASE).href; out.push(h); }
    });
    return out;
  }
}

module.exports = new EmailGenerator();
