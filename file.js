'use strict';

const Path = require('path');
const fs = require("fs");

const Ammo = require('@hapi/ammo');
const Boom = require('@hapi/boom');
const Hoek = require('@hapi/hoek');
const Joi = require('@hapi/joi');

const Etag = require('@hapi/inert/lib/etag');
const Fs = require('@hapi/inert/lib/fs');

const internals = {};


internals.defaultMap = {
    gzip: ".gz",
    br: ".br"
};


internals.schema = Joi.alternatives([
    Joi.string(),
    Joi.func(),
    Joi.object({
        path: Joi.alternatives(Joi.string(), Joi.func()).required(),
        confine: Joi.alternatives(Joi.string(), Joi.boolean()).default(true),
        filename: Joi.string(),
        mode: Joi.string().valid('attachment', 'inline').allow(false),
        lookupCompressed: Joi.boolean(),
        lookupMap: Joi.object().min(1).pattern(/.+/, Joi.string()),
        etagMethod: Joi.string().valid('hash', 'simple').allow(false),
        start: Joi.number().integer().min(0).default(0),
        end: Joi.number().integer().min(Joi.ref('start'))
    })
        .with('filename', 'mode')
]);



exports.fileHandler = (route, options) => {
    let settings = Joi.attempt(options, internals.schema, 'Invalid file handler options (' + route.path + ')');
    settings = (typeof options !== 'object' ? { path: options, confine: '.' } : settings);
    settings.confine = settings.confine === true ? '.' : settings.confine;
    Hoek.assert(typeof settings.path !== 'string' || settings.path[settings.path.length - 1] !== '/', 'File path cannot end with a \'/\':', route.path);

    const handler = (request) => {
        const cache = request.server.plugins["postcss"]["_cache"];
        const path = (typeof settings.path === 'function' ? settings.path(request) : settings.path);
        const cached = cache.get(path);
        if (cached) {
            return cached;
        } else {
            const resp = exports.response(path, settings, request);
            cache.set(path, resp);
            return resp;
        }
    };

    return handler;
};


exports.response = exports.fileResponse = function (path, options, request, _preloaded) {

    Hoek.assert(!options.mode || ['attachment', 'inline'].indexOf(options.mode) !== -1, 'options.mode must be either false, attachment, or inline');

    if (options.confine) {
        const confineDir = Path.resolve(request.route.settings.files.relativeTo, options.confine);
        path = Path.isAbsolute(path) ? Path.normalize(path) : Path.join(confineDir, path);

        // Verify that resolved path is within confineDir
        if (path.lastIndexOf(confineDir, 0) !== 0) {
            path = null;
        }
    } else {
        path = Path.isAbsolute(path) ? Path.normalize(path) : Path.join(request.route.settings.files.relativeTo, path);
    }

    const source = {
        path,
        settings: options,
        stat: null,
        file: null
    };

    const prepare = _preloaded ? null : internals.prepare;

    return request.generateResponse(source, { variety: 'file', marshal: internals.marshal, prepare });
};


internals.prepare = async function (response) {
    const cache = response.request.server.plugins.postcss["_cache"];
    const path = response.source.path;
    if (path === null) {
        throw Boom.forbidden(null, { code: 'EACCES' });
    }
    const cached = cache.get(path);
    if (cached) {
        if (!response.headers['content-type']) {
            response.type('text/css');
        }
        if (cached.mtime) {
            response.header('last-modified', cached.mtime);
        }
        if (cached.etag) {
            response.etag(cached.etag, { vary: true });
        }
        
        return response;
    }
    const file = response.source.file = new Fs.File(path);
    try {
        const stat = await file.openStat('r');
        // const start = response.source.settings.start || 0;
        // if (response.source.settings.end !== undefined) {
        //     response.bytes(response.source.settings.end - start + 1);
        // }
        // else {
        //     response.bytes(stat.size - start);
        // }

        if (!response.headers['content-type']) {
            response.type('text/css');
        }

        response.header('last-modified', stat.mtime.toUTCString());

        await Etag.apply(response, stat);
        
        return response;
    } catch (err) {
        internals.close(response);
        throw err;
    }
};


internals.marshal = async function (response) {
    const cache = response.request.server.plugins.postcss["_cache"];
    const path = response.source.path;
    const cached = cache.get(path);
    let output;
    if (cached && cached.data) {
        response.header('last-modified', cached.mtime);
        const start = response.source.settings.start || 0;
        if (response.source.settings.end !== undefined) {
            response.bytes(response.source.settings.end - start + 1);
        } else {
            response.bytes(cached.size - start);
        }
        output = cached.data.css;
    } else {
        const data = {};
        data.mtime = response.headers["last-modified"];
        data.etag = response.headers["etag"];
        data.data = await internals.processCSS(response);
        data.size = data.data.css.length;
        cache.set(path, data);
        const start = response.source.settings.start || 0;
        if (response.source.settings.end !== undefined) {
            response.bytes(response.source.settings.end - start + 1);
        } else {
            response.bytes(data.size - start);
        }
        output = data.data.css;
    }
    response.source = {};
    return output;
};


internals.addContentRange = function (response) {

    const request = response.request;
    const length = response.headers['content-length'];
    let range = null;

    if (request.route.settings.response.ranges) {
        if (request.headers.range && length) {

            // Check If-Range

            if (!request.headers['if-range'] ||
                request.headers['if-range'] === response.headers.etag) {            // Ignoring last-modified date (weak)

                // Check that response is not encoded once transmitted

                const mime = request.server.mime.type(response.headers['content-type'] || 'application/octet-stream');
                const encoding = (request.server.settings.compression && mime.compressible && !response.headers['content-encoding'] ? request.info.acceptEncoding : null);

                if (encoding === 'identity' || !encoding) {

                    // Parse header

                    const ranges = Ammo.header(request.headers.range, length);
                    if (!ranges) {
                        const error = Boom.rangeNotSatisfiable();
                        error.output.headers['content-range'] = 'bytes */' + length;
                        throw error;
                    }

                    // Prepare transform

                    if (ranges.length === 1) {                                          // Ignore requests for multiple ranges
                        range = ranges[0];
                        response.code(206);
                        response.bytes(range.to - range.from + 1);
                        response.header('content-range', 'bytes ' + range.from + '-' + range.to + '/' + length);
                    }
                }
            }
        }

        response.header('accept-ranges', 'bytes');
    }

    return range;
};


internals.processCSS = async (response) => {
    const postcss = response.request.server.plugins["postcss"]["postcss"];
    const data = await fs.promises.readFile(response.source.path);

    return await postcss.process(data, { from: "undefined"});
};

exports.load = function (path, request, options) {
    const resp = exports.response(path, options, request, true);
    return internals.prepare(resp);
};