'use strict';

const Boom = require('@hapi/boom');
const Bounce = require('@hapi/bounce');
const Hoek = require('@hapi/hoek');
const Joi = require('@hapi/joi');

const File = require('./file');

const schema = Joi.object({
    path: Joi.alternatives(Joi.array().items(Joi.string()).single(), Joi.func()).required(),
    index: Joi.alternatives(Joi.boolean(), Joi.array().items(Joi.string()).single()).default(true),
    listing: Joi.boolean(),
    showHidden: Joi.boolean(),
    redirectToSlash: Joi.boolean(),
    lookupCompressed: Joi.boolean(),
    lookupMap: Joi.object().min(1).pattern(/.+/, Joi.string()),
    etagMethod: Joi.string().valid('hash', 'simple').allow(false),
    defaultExtension: Joi.string().alphanum()
});


const resolvePathOption = function (result) {

    if (result instanceof Error) {
        throw result;
    }

    if (typeof result === 'string') {
        return [result];
    }

    if (Array.isArray(result)) {
        return result;
    }

    throw Boom.internal('Invalid path function');
};


exports.handler = function (route, options) {
    const settings = Joi.attempt(options, schema, 'Invalid directory handler options (' + route.path + ')');
    Hoek.assert(route.path[route.path.length - 1] === '}', 'The route path for a directory handler must end with a parameter:', route.path);
    // console.log(route);
    const paramName = /\w+/.exec(route.path.slice(route.path.lastIndexOf('{')))[0];
    const normalized = (Array.isArray(settings.path) ? settings.path : null);                            // Array or function
    // Declare handler
    const handler = async (request) => {
        // console.log(route);
        const paths = normalized || resolvePathOption(settings.path.call(null, request));

        // Append parameter

        const selection = request.params[paramName];
        if (selection &&
            !settings.showHidden &&
            isFileHidden(selection)) {

            throw Boom.notFound(null, {});
        }

        // Generate response

        const resource = request.path;
        const hasTrailingSlash = resource.endsWith('/');
        const fileOptions = {
            confine: null,
            lookupCompressed: settings.lookupCompressed,
            lookupMap: settings.lookupMap,
            etagMethod: settings.etagMethod
        };

        const each = async (baseDir) => {

            fileOptions.confine = baseDir;

            let path = selection || '';
            let error;

            try {
                return await File.load(path, request, fileOptions);
            }
            catch (err) {
                Bounce.ignore(err, 'boom');
                error = err;
            }

            // Handle Not found
            if (isNotFound(error)) {
                if (!settings.defaultExtension) {
                    throw error;
                }

                if (hasTrailingSlash) {
                    path = path.slice(0, -1);
                }

                return await File.load(path + '.' + settings.defaultExtension, request, fileOptions);
            }

            throw error;
        };

        for (let i = 0; i < paths.length; ++i) {
            try {
                return await each(paths[i]);
            }
            catch (err) {
                Bounce.ignore(err, 'boom');

                // Propagate any non-404 errors

                if (!isNotFound(err) ||
                    i === paths.length - 1) {
                    throw err;
                }
            }
        }

        throw Boom.notFound(null, {});
    };

    return handler;
};

const isFileHidden = function (path) {
    return /(^|[\\/])\.([^.\\/]|\.[^\\/])/.test(path);           // Starts with a '.' or contains '/.' or '\.', which is not followed by a '/' or '\' or '.'
};


const isNotFound = function (boom) {
    return boom.output.statusCode === 404;
};
