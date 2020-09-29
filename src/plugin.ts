// eslint-disable-next-line import/no-extraneous-dependencies
import { Response } from 'firebase-functions';
// eslint-disable-next-line import/no-extraneous-dependencies
import { Request } from 'firebase-functions/lib/providers/https';
import AdminBro, { AdminBroOptions, CurrentAdmin } from 'admin-bro';
import { resolve } from 'path';
import { match } from 'path-to-regexp';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { computeRootPaths } from './utils/compute-root-paths';
import { prepareComparePath } from './utils/prepare-compare-path';


import { AppRoutes, AppAssets } from './utils/routes';
import { parseFiles, cleanFiles, File } from './utils/parse-files';

/**
 * @alias BuildHandlerReturn
 *
 * @memberof module:@admin-bro/firebase-functions
 */
export type BuildHandlerReturn = ((req: Request, resp: Response) => Promise<void>)

/**
 * @alias BuildHandlerOptions
 *
 * @memberof module:@admin-bro/firebase-functions
 */
export type BuildHandlerOptions = {
  /** Region where function is deployed */
  region: string;
  /**
   * Optional before `async` hook which can be used to initialize database.
   * if it returns something it will be used as AdminBroOptions.
   */
  before?: () => Promise<AdminBroOptions | undefined | null> | AdminBroOptions | undefined | null;
  /**
   * custom authentication option. If given AdminBro will render login page
   */
  auth?: {
    /**
     * secret which is used to encrypt the session cookie
     */
    secret: string;
    /**
     * authenticate function
     */
    authenticate: (
      email: string,
      password: string
    ) => Promise<CurrentAdmin | null> | CurrentAdmin | null;

    /**
     * For how long cookie session will be stored.
     * Default to 900000 (15 minutes).
     * In milliseconds.
     */
    maxAge?: number;
  };
}

const DEFAULT_MAX_AGE = 900000;

/**
 * Builds the handler which can be passed to firebase functions
 *
 * usage:
 *
 * ```javascript
 * const functions = require('firebase-functions')
 * const { buildHandler } = require('@admin-bro/firebase-functions')
 *
 * const adminOptions = {...}
 * const region = '...'
 *
 * exports.app = functions.https.onRequest(buildHandler(adminOptions, { region }));
 *
 * ```
 *
 * @alias buildHandler
 * @param  {AdminBroOptions} adminOptions       options which are used to initialize
 *                                              AdminBro instance
 * @param  {BuildHandlerOptions} options        custom options for @admin-bro/firebase-functions
 *                                              adapter
 * @param {string} customFunctionPath           "adjustment" path when you proxy domain to a created
 *                                              function
 * @return {BuildHandlerReturn}                 function which can be passed to firebase
 * @function
 * @memberof module:@admin-bro/firebase-functions
*/
export const buildHandler = (
  adminOptions: AdminBroOptions,
  options: BuildHandlerOptions,
  customFunctionPath?: string,
): BuildHandlerReturn => {
  let admin: AdminBro;

  let loginPath: string;
  let logoutPath: string;
  let rootPath: string;

  return async (req, res): Promise<void> => {
    if (!admin) {
      let beforeResult: AdminBroOptions | null | undefined = null;
      if (options.before) {
        beforeResult = await options.before();
      }

      admin = new AdminBro(beforeResult || adminOptions);
      // we have to store original values
      ({ loginPath, logoutPath, rootPath } = admin.options);

      Object.assign(admin.options, computeRootPaths(admin.options, {
        project: process.env.GCLOUD_PROJECT as string,
        region: options.region,
        target: process.env.FUNCTION_TARGET as string,
        emulator: process.env.FUNCTIONS_EMULATOR,
      }), customFunctionPath);
    }

    const { method, query } = req;
    const path = prepareComparePath(req.path, rootPath);

    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies && cookies.__session;

    const currentAdmin = options.auth && token && token !== ''
      ? jwt.verify(token, options.auth.secret)
      : null;

    if (options.auth) {
      const matchLogin = match(loginPath);
      if (matchLogin(req.path)) {
        if (method === 'GET') {
          res.send(await admin.renderLogin({
            action: admin.options.loginPath,
            errorMessage: null,
          }));
        } else {
          const { email, password } = req.body;
          const user = await options.auth.authenticate(email, password);
          if (user) {
            const session = jwt.sign(user, options.auth.secret);
            res.cookie('__session', session, {
              maxAge: options.auth.maxAge || DEFAULT_MAX_AGE,
            });
            res.redirect(admin.options.rootPath);
          } else {
            res.send(await admin.renderLogin({
              action: admin.options.loginPath,
              errorMessage: admin.translateMessage('invalidCredentials'),
            }));
          }
        }
        return;
      }

      const matchLogout = match(logoutPath);
      if (matchLogout(req.path)) {
        res.cookie('__session', '');
        res.redirect(admin.options.loginPath);
        return;
      }

      if (!currentAdmin) {
        res.redirect(admin.options.loginPath);
        return;
      }

      res.cookie('__session', token, {
        maxAge: options.auth.maxAge || DEFAULT_MAX_AGE,
      });
    }

    const route = AppRoutes.find((r) => r.match(path) && r.method === method);
    if (route) {
      const params = (route.match(path) as unknown as any).params as Record<string, string>;

      const controller = new route.Controller({ admin }, currentAdmin);
      let fields: Record<string, string> = {};
      let files: Record<string, File> = {};
      if (method === 'POST') {
        ({ fields, files } = await parseFiles(req));
      }
      const payload = {
        ...fields,
        ...files,
      };
      const html = await controller[route.action]({
        ...req, params, query, payload, method: method.toLowerCase(),
      }, res);
      if (route.contentType) {
        res.set({ 'Content-Type': route.contentType });
      }
      if (html) {
        res.send(html);
      }

      if (files) {
        cleanFiles(files);
      }

      return;
    }

    const asset = AppAssets.find((r) => r.match(path));
    if (asset && !admin.options.assetsCDN) {
      res.status(200).sendFile(resolve(asset.src));
      return;
    }

    res.status(404).send('Page not found');
  };
};
