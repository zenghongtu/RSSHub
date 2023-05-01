const Router = require('@koa/router');
const logger = require('@/utils/logger');
const got = require('@/utils/got');
const cheerio = require('cheerio');

const router = new Router();

const getResponse = async (url, enableJS) => {
    let response;
    let headers;

    if (+enableJS) {
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
    // TODO add fields
    // // 文章发布日期
    // 'pubDate',
    // 如果有的话，文章作者
    'author',
    // // 如果有的话，文章分类
    // 'category',
];

router.get('/query/:url?', async (ctx) => {
    const url = ctx.params.url || ctx.query.url;
    const { enableJS, item, ...restQuery } = ctx.query;

    if (!item) {
        throw new Error('Missing item selector!');
    }

    const selectors = Object.keys(restQuery)
        .filter((key) => selectorKeys.includes(key))
        .reduce((ret, name) => {
            ret[name] = restQuery[name];
            return ret;
        }, {});

    const { response } = await getResponse(url, enableJS);

    const $ = cheerio.load(response);

    const items = $(item)
        .map((idx, context) => {
            const result = {};
            if (!selectors.link) {
                const href = $('[href]', $.html(context)).attr('href');

                if (!href) {
                    logger.warn(`can't get href by itemSelector(${item})`);
                }
                result.link = href;
                result.title = $(context).text();
            } else {
                Object.keys(selectors).forEach((name) => {
                    const selector = selectors[name];

                    const $el = $(selector, context);
                    let ret = '';

                    if (name === 'link') {
                        ret = $el.attr('href');
                        if (!ret) {
                            logger.warn(`can't get href by selector(${selector}), use text`);
                            ret = $el.text();
                        }
                    } else {
                        ret = $el.text();
                    }

                    result[name] = ret.trim();
                });
            }
            return result;
        })
        .get();

    const title = $('title').text();

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
