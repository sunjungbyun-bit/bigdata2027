import handler from '../server.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const req = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries())
    };

    return new Promise((resolve, reject) => {
      const responseHeaders = new Headers();
      const res = {
        writeHead(status, headers = {}) {
          this.statusCode = status;
          for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
        },
        end(body = '') {
          resolve(new Response(body, { status: this.statusCode || 200, headers: responseHeaders }));
        }
      };

      Promise.resolve(handler(req, res)).catch(reject);
    });
  }
};