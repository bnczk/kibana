/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import Path from 'path';
import Fs from 'fs';

import { readFileSync, writeFileSync } from 'fs';
import execa from 'execa';
import sass from 'node-sass';
import del from 'del';
import File from 'vinyl';
import vfs from 'vinyl-fs';
import through from 'through2';
import minimatch from 'minimatch';
// @ts-ignore
import gulpBabel from 'gulp-babel';

import { ToolingLog } from '@kbn/dev-utils';
import { OptimizerConfig, runOptimizer, logOptimizerState } from '@kbn/optimizer';

import { PluginConfig, winCmd, pipeline } from '../../lib';
import { gitInfo } from './git_info';

function tapFiles(fn: (file: File) => void) {
  return through.obj((file: File, _, cb) => {
    fn(file);
    cb(null, file);
  });
}

// parse a ts config file
function parseTsconfig(pluginSourcePath: string, configPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require(Path.join(pluginSourcePath, 'node_modules', 'typescript'));

  const { error, config } = ts.parseConfigFileTextToJson(
    configPath,
    readFileSync(configPath, 'utf8')
  );

  if (error) {
    throw error;
  }

  return config;
}

// transpile with babel
async function transpileWithBabel(srcGlobs: string[], buildDir: string, presets: string[]) {
  await pipeline(
    vfs.src(
      srcGlobs.concat([
        '!**/*.d.ts',
        '!**/*.{test,test.mocks,mock,mocks}.{ts,tsx}',
        '!**/node_modules/**',
        '!**/bower_components/**',
        '!**/__tests__/**',
      ]),
      {
        cwd: buildDir,
      }
    ),

    gulpBabel({
      babelrc: false,
      presets,
    }),

    vfs.dest(buildDir)
  );
}

export async function createBuild({
  plugin,
  buildVersion,
  kibanaVersion,
  files,
}: {
  plugin: PluginConfig;
  buildVersion: string;
  kibanaVersion: string;
  files: string[];
}) {
  const buildDir = Path.resolve(plugin.root, 'build/kibana', plugin.id);
  const sourcePkgJsonPath = Path.resolve(plugin.root, 'package.json');

  await del(Path.resolve(plugin.root, 'build'));

  // compile kibana platform plugins
  if (plugin.usesKp) {
    const config = OptimizerConfig.create({
      repoRoot: plugin.kibanaRoot,
      pluginPaths: [plugin.root],
      cache: false,
      dist: true,
      pluginScanDirs: [],
    });

    const log = new ToolingLog({
      level: 'info',
      writeTo: process.stdout,
    });

    await runOptimizer(config)
      .pipe(logOptimizerState(log, config))
      .toPromise();

    // copy optimizer output to build
    await pipeline(
      vfs.src(['**/*'], { cwd: Path.resolve(plugin.root, 'target/public') }),
      vfs.dest(Path.resolve(buildDir, 'target/public'))
    );

    del.sync(Path.resolve(plugin.root, 'target'));
  }

  // copy source files and apply some transformations in the process
  await pipeline(
    vfs.src(files, {
      cwd: plugin.root,
      base: plugin.root,
      allowEmpty: true,
    }),

    // update the package.json file
    tapFiles(file => {
      if (file.path !== sourcePkgJsonPath) {
        return;
      }

      const pkg = JSON.parse(file.contents!.toString('utf8'));
      pkg.kibana = {
        ...pkg.kibana,
        version: kibanaVersion,
      };
      pkg.version = buildVersion;
      pkg.build = {
        git: gitInfo(plugin.root),
        date: new Date().toString(),
      };

      // remove development properties from the package file
      delete pkg.scripts;
      delete pkg.devDependencies;

      file.contents = Buffer.from(JSON.stringify(pkg, null, 2));
    }),

    vfs.dest(buildDir)
  );

  // install packages in build
  if (!plugin.skipInstallDependencies) {
    execa.sync(winCmd('yarn'), ['install', '--production', '--pure-lockfile'], {
      cwd: buildDir,
    });
  }

  // compile stylesheet
  if (typeof plugin.styleSheetToCompile === 'string') {
    const absSource = plugin.styleSheetToCompile;
    const relativeSource = Path.relative(plugin.root, absSource);
    const sourceExt = Path.extname(plugin.styleSheetToCompile);
    const absOutput = Path.resolve(buildDir, `${relativeSource.slice(0, -sourceExt.length)}.css`);
    const rendered = sass.renderSync({ file: absSource, absOutput });

    Fs.mkdirSync(Path.dirname(absOutput), { recursive: true });
    writeFileSync(absOutput, rendered.css);

    del.sync([Path.resolve(buildDir, '**/*.s{a,c}ss')]);
  }

  // transform typescript to js and clean out typescript
  const tsConfigPath = Path.join(buildDir, 'tsconfig.json');
  if (Fs.existsSync(tsConfigPath)) {
    // attempt to patch the extends path in the tsconfig file
    const buildConfig = parseTsconfig(plugin.root, tsConfigPath);

    if (buildConfig.extends) {
      buildConfig.extends = Path.join(Path.relative(buildDir, plugin.root), buildConfig.extends);

      writeFileSync(tsConfigPath, JSON.stringify(buildConfig));
    }

    // Transpile ts server code
    //
    // Include everything except content from public folders
    await transpileWithBabel(['**/*.{ts,tsx}', '!**/public/**'], buildDir, [
      require.resolve('@kbn/babel-preset/node_preset'),
    ]);

    // Transpile ts client code
    //
    // Include everything inside a public directory
    await transpileWithBabel(['**/public/**/*.{ts,tsx}'], buildDir, [
      require.resolve('@kbn/babel-preset/webpack_preset'),
    ]);

    del.sync([Path.join(buildDir, '**', '*.{ts,tsx,d.ts}'), Path.join(buildDir, 'tsconfig.json')]);
  }

  // `link:` dependencies create symlinks, but we don't want to include symlinks
  // in the built zip file. Therefore we remove all symlinked dependencies, so we
  // can re-create them when installing the plugin.
  await pipeline(
    vfs.src(['**/*'], {
      cwd: buildDir,
      resolveSymlinks: false,
    }),

    tapFiles(file => {
      if (file.symlink && minimatch(file.path, '**/node_modules/**')) {
        Fs.unlinkSync(file.path);
      }
    })
  );
}
