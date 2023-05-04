const Router = require('@koa/router');
const logger = require('@/utils/logger');
const got = require('@/utils/got');
const cheerio = require('cheerio');
const cssSelect = require('css-select');
const { parseDate } = require('@/utils/parse-date');

const router = new Router();

const getResponse = async (url, enableJS) => {
    let response;
    let headers;

    if (enableJS === 'true') {
        // TODO move puppeteer to middleware
        const browser = await require('@/utils/puppeteer')();
        // 打开一个新标签页
        const page = await browser.newPage();
        // 拦截所有请求
        await page.setRequestInterception(true);
        // 仅允许某些类型的请求
        page.on('request', (request) => {
            // 在这次例子，我们只允许 HTML 请求
            request.resourceType() === 'document' ? request.continue() : request.abort();
        });
        // 访问目标链接
        const link = url;
        // got 请求会被自动记录，
        // 但 puppeteer 请求不会
        // 所以我们需要手动记录它们
        logger.debug(`Requesting ${link}`);

        const rsp = await page.goto(link, {
            // 指定页面等待载入的时间
            waitUntil: 'domcontentloaded',
        });

        headers = rsp.headers();

        // 获取页面的 HTML 内容
        response = await page.content();

        // 关闭标签页
        page.close();

        // 不要忘记关闭浏览器实例
        browser.close();
    } else {
        const rsp = await got(url);
        response = rsp.data;
        headers = rsp.headers;
    }

    // TODO handle charset
    return { response, headers };
};

const expressionRegex = new RegExp(/\$\((['"].*['"])\)/g);

const isExpression = (source) => expressionRegex.test(source);

const compileExpression = (expression, $) => {
    try {
        // TODO 安全处理
        // eslint-disable-next-line no-new-func
        const ret = new Function('$', `return ${expression};`)($);
        return ret;
    } catch (err) {
        logger.warn(`compile ${expression} error: ${err.message}`);
        return undefined;
    }
};

const isValidSelector = (selector) => {
    if (!selector) {
        return false;
    }
    try {
        cssSelect.compile(selector);
    } catch {
        return false;
    }
    return true;
};

router.get('/webpage/:url?', async (ctx) => {
    const url = ctx.params.url || ctx.query.url;
    const { enableJS } = ctx.query;

    const { response } = await getResponse(url, enableJS);

    ctx.body = { url, response };
});

const selectorKeys = [
    // 文章标题
    'title',
    // 文章链接
    'link',
    // 文章正文
    'description',
    // 文章发布日期
    'pubDate',
    // 如果有的话，文章作者
    'author',
    // // 如果有的话，文章分类
    // 'category',
];

router.get('/query/:url?', async (ctx) => {
    const url = ctx.params.url || ctx.query.url;
    const { enableJS, feedTitle, item } = ctx.query;
    // TODO cookie

    if (!item || !isValidSelector(item)) {
        throw new Error('Item selector is invalid!');
    }

    const { response } = await getResponse(url, enableJS);

    const $ = cheerio.load(response);

    const selectors = Object.keys(ctx.query)
        .filter((key) => !!ctx.query[key])
        .filter((key) => selectorKeys.includes(key))
        .reduce((ret, name) => {
            ret[name] = ctx.query[name];
            return ret;
        }, {});

    const items = $(item)
        .map((_, el) => {
            const result = {};

            if (!selectors.link || !selectors.title) {
                let link = (selectors.link ? $(selectors.link, el) : $('[href]', el)).attr('href')?.split('#')[0];
                if (link) {
                    link = new URL(link, url).toString();
                    result.link = link;
                }

                result.title = $(el).text();

                return result;
            }

            Object.keys(selectors).forEach((name) => {
                const selector = selectors[name];

                let ret;
                if (isExpression(selector)) {
                    const $el = (e) => $(el).find(e);
                    const compileResult = compileExpression(selector, $el);
                    if (typeof compileResult !== 'string') {
                        return;
                    } else {
                        ret = compileResult;
                    }
                } else if (isValidSelector(selector)) {
                    if (name === 'link') {
                        ret = $(selector, el).attr('href')?.split('#')[0];
                    } else {
                        ret = $(selector, el)?.text();
                    }
                }

                if (ret) {
                    if (name === 'link') {
                        ret = new URL(ret, url).toString();
                    } else if (name === 'pubDate') {
                        ret = parseDate(ret);
                    }
                    result[name] = ret;
                }
            });

            return result;
        })
        .get();

    const title = feedTitle || $('title').text();

    ctx.state.data = {
        // 源标题
        title,
        // 源链接
        link: url,
        // 源文章
        item: items,
    };
});

module.exports = router;
