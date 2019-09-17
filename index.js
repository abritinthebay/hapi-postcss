const Hoek = require('@hapi/hoek');
const Joi = require('@hapi/joi');

const postcss = require('postcss');

const Etag = require('@hapi/inert/lib/etag');
const {fileResponse, fileHandler} = require('./file.js');
const Directory = require('./directory.js');


const internals = {
    schema: Joi.object({
        etagsCacheMaxSize: Joi.number().integer().min(0).default(1000),
    }).required()
};


internals.fileMethod = function (path, responseOptions) {
    // Set correct confine value
    responseOptions = responseOptions || {};
    if (typeof responseOptions.confine === 'undefined' || responseOptions.confine === true) {
        responseOptions.confine = '.';
    }
    Hoek.assert(responseOptions.end === undefined || +responseOptions.start <= +responseOptions.end, 'options.start must be less than or equal to options.end');
    return this.response(fileResponse(path, responseOptions, this.request));
};

class inMemoryCache {
    constructor() {
        this.cache = {}
    }
    get(key) {
        return this.cache.hasOwnProperty(key) ? this.cache[key] : null;
    }
    set(key, data) {
        this.cache[key] = data;
    }
}


exports.plugin = {
    name: 'postcss',
    pkg: require('./package.json'),
    once: true,
    requirements: {
        hapi: '>=17.7.0'
    },

    register(server, options) {
        const settings = Joi.attempt(Hoek.reach(server.settings.plugins, 'postcss') || {}, internals.schema, 'Invalid "postcss" server options');
        server.expose('_etags', settings.etagsCacheMaxSize > 0 ? new Etag.Cache(settings.etagsCacheMaxSize) : null);
        server.expose('_cache', settings.cache || new inMemoryCache());
        server.expose('postcss', postcss(options.plugins));
        
        server.decorate('handler', 'css', fileHandler);
        server.decorate('handler', 'cssdirectory', Directory.handler);
        server.decorate('toolkit', 'css', internals.fileMethod);
    }
};