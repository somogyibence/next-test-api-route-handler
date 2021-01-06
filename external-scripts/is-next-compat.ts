import { basename, dirname } from 'path';
import { name as pkgName } from '../package.json';
import { Octokit } from '@octokit/rest';
import { MongoClient } from 'mongodb';
import sjx from 'shelljs';
import findPackageJson from 'find-package-json';
import Debug from 'debug';

const mode = `${pkgName}:${basename(__filename).split('.').find(Boolean)}`;

sjx.config.silent = true;

export async function main(isCli = false) {
  const debug = Debug(mode);
  // ? Print debug messages to stdout if isCli == true
  // eslint-disable-next-line no-console
  debug.log = (...args) => void console[isCli ? 'log' : 'error'](...args);

  if (isCli && !process.env.DEBUG) Debug.enable(mode);

  /**
   * Update the cluster with the new information so that the badge stays current
   */
  const setCompatFlagTo = async (version: string) => {
    try {
      // ? Update database
      if (process.env.MONGODB_URI) {
        if (!process.env.NO_DB_UPDATE) {
          const client = await MongoClient.connect(process.env.MONGODB_URI, {
            useUnifiedTopology: true
          });

          await client
            .db()
            .collection('flags')
            .updateOne(
              { compat: { $exists: true } },
              { $set: { compat: version } },
              { upsert: true }
            );

          await client.close();
        } else debug('(NO_DB_UPDATE in effect)');

        debug(`updated database compat: "${version}"`);
      } else debug('skipped updating database (no MONGODB_URI)');
    } catch (e: unknown) {
      debug('additionally, an attempt to update the database failed');
      throw e;
    }
  };

  const getLastTestedVersion = async () => {
    let version = '';

    try {
      // ? Update database
      if (process.env.MONGODB_URI) {
        const client = await MongoClient.connect(process.env.MONGODB_URI, {
          useUnifiedTopology: true
        });

        version =
          (
            await client
              .db()
              .collection('flags')
              .findOne<{ compat: string }>({ compat: { $exists: true } })
          )?.compat || '';

        await client.close();
      } else debug('skipped database last tested version check (no MONGODB_URI)');
    } catch (e: unknown) {
      debug('database access failed');
      throw e;
    }

    debug(`latest tested version: "${version}"`);
    return version;
  };

  let error = false;

  try {
    debug('connecting to GitHub');

    if (!process.env.GH_TOKEN)
      isCli && debug('warning: not using a personal access token!');

    const { repos } = new Octokit({
      auth: process.env.GH_TOKEN,
      userAgent: 'Xunnamius/next-test-api-route-handler/external-scripts/is-next-compat'
    });

    const {
      data: { tag_name: vlatest }
    } = await repos.getLatestRelease({
      owner: 'vercel',
      repo: 'next.js'
    });

    const latest = vlatest.replace(/^v/, '');

    debug(`saw latest release version "${latest}"`);

    const { value: pkg, filename: path } = findPackageJson(process.cwd()).next();

    if (!path || !pkg) throw new Error('could not find package.json');

    debug(`using package.json @ "${path}"`);

    const cd = sjx.cd(dirname(path));

    if (cd.code != 0) throw new Error(`cd failed: ${cd.stderr} ${cd.stdout}`);

    const prev: string = await getLastTestedVersion();
    const dist: string = pkg.peerDependencies?.next ?? '';

    if (!dist) throw new Error('could not find Next.js peer dependency in package.json');

    debug('last tested version was ' + (prev ? `"${prev}"` : '(not tested)') + '');

    if (latest != prev) {
      if (dist != latest) {
        debug(`installing next@${latest}`);

        const npmi = sjx.exec(`npm install --no-save next@${latest}`);

        if (npmi.code != 0)
          throw new Error(`initial npm install failed: ${npmi.stderr} ${npmi.stdout}`);
      } else debug(`no additional installation necessary`);

      debug('running compatibility test');

      const test = sjx.exec('npm run test-unit && npm run test-integration');

      if (test.code != 0) {
        debug(`npm test failed! The latest Next.js is incompatible with this package`);
        throw new Error(`npm test failed: ${test.stderr} ${test.stdout}`);
      }

      debug('test succeeded');

      await setCompatFlagTo(latest);
    } else debug('no new release detected');

    debug('execution complete');

    return true;
  } catch (e) {
    if (isCli) {
      debug('FATAL', e);
      error = true;
    }

    // ? We either resolve to `true` or reject with e
    else throw new Error(e);
  } finally {
    isCli && process.exit(Number(error));
  }
}

!module.parent && main(true);
