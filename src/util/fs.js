/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import BlockingQueue from './BlockingQueue.js';
import * as promise from './promise.js';
import {promisify} from './promise.js';
import map from './map.js';

const path = require('path');
const fs = require('fs');

export const lockQueue = new BlockingQueue('fs lock');

export const readFileBuffer = promisify(fs.readFile);
export const writeFile = promisify(fs.writeFile);
export const readlink = promisify(fs.readlink);
export const realpath = promisify(fs.realpath);
export const readdir = promisify(fs.readdir);
export const rename = promisify(fs.rename);
export const access = promisify(fs.access);
export const unlink = promisify(require('rimraf'));
export const mkdirp = promisify(require('mkdirp'));
export const exists = promisify(fs.exists, true);
export const lstat = promisify(fs.lstat);
export const chmod = promisify(fs.chmod);

const fsSymlink = promisify(fs.symlink);
const invariant = require('invariant');
const stripBOM = require('strip-bom');

const noop = () => {};

type CopyQueue = Array<{
  src: string,
  dest: string,
  onFresh?: ?() => void,
  onDone?: ?() => void,
}>;

type CopyFileAction = {
  type: 'file',
  src: string,
  dest: string,
  atime: number,
  mtime: number,
  mode: number
};

type CopySymlinkAction = {
  type: 'symlink',
  dest: string,
  linkname: string,
};

type CopyActions = Array<CopyFileAction | CopySymlinkAction>;

type CopyEvents = {
  onProgress: (dest: string) => void,
  onStart: (num: number) => void
};

async function buildActionsForCopy(
  queue: CopyQueue,
  events: CopyEvents,
  possibleExtraneousSeed: ?Iterable<string>,
): Promise<CopyActions> {
  const possibleExtraneous: Set<string> = new Set(possibleExtraneousSeed || []);
  const files: Set<string> = new Set();

  // initialise events
  for (const item of queue) {
    item.onDone = () => {
      events.onProgress(item.dest);
    };
  }
  events.onStart(queue.length);

  // start building actions
  const actions: CopyActions = [];

  // custom concurrency logic as we're always executing stacks of 4 queue items
  // at a time due to the requirement to push items onto the queue
  while (queue.length) {
    const items = queue.splice(0, 4);
    await Promise.all(items.map(build));
  }

  // remove all extraneous files that weren't in the tree
  for (const loc of possibleExtraneous) {
    if (!files.has(loc)) {
      await unlink(loc);
    }
  }

  return actions;

  //
  async function build(data) {
    let {src, dest} = data;
    const onDone = data.onDone || noop;
    const onFresh = data.onFresh || noop;
    files.add(dest);

    const srcStat = await lstat(src);
    let srcFiles;

    if (srcStat.isDirectory()) {
      srcFiles = await readdir(src);
    }

    if (await exists(dest)) {
      const destStat = await lstat(dest);

      const bothFiles = srcStat.isFile() && destStat.isFile();
      const bothFolders = !bothFiles && srcStat.isDirectory() && destStat.isDirectory();
      const bothSymlinks = !bothFolders && !bothFiles && srcStat.isSymbolicLink() && destStat.isSymbolicLink();

      if (srcStat.mode !== destStat.mode) {
        if (bothFiles) {
          await access(dest, srcStat.mode);
        } else {
          possibleExtraneous.delete(dest);
          await unlink(dest);
          await build(data);
          return;
        }
      }

      if (bothFiles && srcStat.size === destStat.size && +srcStat.mtime === +destStat.mtime) {
        // we can safely assume this is the same file
        onDone();
        return;
      }

      if (bothSymlinks && await readlink(src) === await readlink(dest)) {
        // if both symlinks are the same then we can continue on
        onDone();
        return;
      }

      if (bothFolders) {
        // remove files that aren't in source
        const destFiles = await readdir(dest);
        invariant(srcFiles, 'src files not initialised');

        for (const file of destFiles) {
          if (srcFiles.indexOf(file) < 0) {
            const loc = path.join(dest, file);
            possibleExtraneous.add(loc);

            if ((await lstat(loc)).isDirectory()) {
              for (const file of await readdir(loc)) {
                possibleExtraneous.add(path.join(loc, file));
              }
            }
          }
        }
      }
    }

    if (srcStat.isSymbolicLink()) {
      onFresh();
      let linkname = await readlink(src);
      actions.push({
        type: 'symlink',
        dest,
        linkname,
      });
      onDone();
    } else if (srcStat.isDirectory()) {
      await mkdirp(dest);

      const destParts = dest.split(path.sep);
      while (destParts.length) {
        files.add(destParts.join(path.sep));
        destParts.pop();
      }

      // push all files to queue
      invariant(srcFiles, 'src files not initialised');
      let remaining = srcFiles.length;
      if (!remaining) {
        onDone();
      }
      for (const file of srcFiles) {
        queue.push({
          onFresh,
          src: path.join(src, file),
          dest: path.join(dest, file),
          onDone: () => {
            if (--remaining === 0) {
              onDone();
            }
          },
        });
      }
    } else if (srcStat.isFile()) {
      onFresh();
      actions.push({
        type: 'file',
        src,
        dest,
        atime: srcStat.atime,
        mtime: srcStat.mtime,
        mode: srcStat.mode,
      });
      onDone();
    } else {
      throw new Error(`unsure how to copy this: ${src}`);
    }
  }
}

export function copy(src: string, dest: string): Promise<void> {
  return copyBulk([{src, dest}]);
}

export async function copyBulk(
  queue: CopyQueue,
  _events?: CopyEvents,
  possibleExtraneous?: Iterable<string>,
): Promise<void> {
  const events: CopyEvents = _events || {
    onStart: noop,
    onProgress: noop,
  };

  const actions: CopyActions = await buildActionsForCopy(queue, events, possibleExtraneous);
  events.onStart(actions.length);

  const fileActions = actions.filter((action): boolean => action.type === 'file');
  await promise.queue(fileActions, (data): Promise<void> => new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(data.src);
    const writeStream = fs.createWriteStream(data.dest, {mode: data.mode});

    readStream.on('error', reject);
    writeStream.on('error', reject);

    writeStream.on('open', function() {
      readStream.pipe(writeStream);
    });

    writeStream.once('finish', function() {
      fs.utimes(data.dest, data.atime, data.mtime, function(err) {
        if (err) {
          reject(err);
        } else {
          events.onProgress(data.dest);
          resolve();
        }
      });
    });
  }), 4);

  // we need to copy symlinks last as the could reference files we were copying
  const symlinkActions = actions.filter((action): boolean => action.type === 'symlink');
  await promise.queue(symlinkActions, (data): Promise<void> => {
    return fsSymlink(data.linkname, data.dest);
  });
}

async function _readFile(loc: string, encoding: string): Promise<any> {
  return new Promise((resolve, reject) => {
    fs.readFile(loc, encoding, function(err, content) {
      if (err) {
        reject(err);
      } else {
        resolve(content);
      }
    });
  });
}

export async function readFile(loc: string): Promise<string> {
  return _readFile(loc, 'utf8');
}

export async function readFileRaw(loc: string): Promise<Buffer> {
  return _readFile(loc, 'binary');
}

export async function readFileAny(files: Array<string>): Promise<?string> {
  for (let file of files) {
    if (await exists(file)) {
      return readFile(file);
    }
  }
  return null;
}

export async function readJson(loc: string): Promise<Object> {
  const file = await readFile(loc);
  try {
    return map(JSON.parse(stripBOM(file)));
  } catch (err) {
    err.message = `${loc}: ${err.message}`;
    throw err;
  }
}

export async function find(filename: string, dir: string): Promise<string | false> {
  const parts = dir.split(path.sep);

  while (parts.length) {
    const loc = parts.concat(filename).join(path.sep);

    if (await exists(loc)) {
      return loc;
    } else {
      parts.pop();
    }
  }

  return false;
}

export async function symlink(src: string, dest: string): Promise<void> {
  try {
    const stats = await lstat(dest);

    if (stats.isSymbolicLink() && await exists(dest)) {
      const resolved = await realpath(dest);
      if (resolved === src) {
        return;
      }
    }

    await unlink(dest);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  try {
    if (process.platform === 'win32') {
      // use directory junctions if possible on win32, this requires absolute paths
      await fsSymlink(src, dest, 'junction');
    } else {
      // use relative paths otherwise which will be retained if the directory is moved
      const relative = path.relative(path.dirname(dest), src);
      await fsSymlink(relative, dest);
    }
  } catch (err) {
    if (err.code === 'EEXIST') {
      // race condition
      await symlink(src, dest);
    } else {
      throw err;
    }
  }
}

export type WalkFiles = Array<{
  relative: string,
  absolute: string,
  basename: string,
  mtime: number,
}>;

export async function walk(dir: string, relativeDir?: ?string, ignoreBasenames?: Array<string>): Promise<WalkFiles> {
  let files = [];

  let filenames = await readdir(dir);
  if (ignoreBasenames) {
    filenames = filenames.filter((name): boolean => ignoreBasenames.indexOf(name) < 0);
  }

  for (let name of filenames) {
    const relative = relativeDir ? path.join(relativeDir, name) : name;
    const loc = path.join(dir, name);
    const stat = await lstat(loc);

    files.push({
      relative,
      basename: name,
      absolute: loc,
      mtime: +stat.mtime,
    });

    if (stat.isDirectory()) {
      files = files.concat(await walk(loc, relative, ignoreBasenames));
    }
  }

  return files;
}
