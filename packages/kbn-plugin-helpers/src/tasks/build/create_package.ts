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

import del from 'del';
import vfs from 'vinyl-fs';
import zip from 'gulp-zip';

import { pipeline, PluginConfig } from '../../lib';

export async function createPackage(plugin: PluginConfig, buildVersion: string) {
  const buildDir = Path.resolve(plugin.root, 'build');

  // zip up the build files
  await pipeline(
    vfs.src([`kibana/${plugin.id}/**/*`], { cwd: buildDir, base: buildDir }),
    zip(`${plugin.id}-${buildVersion}.zip`),
    vfs.dest(buildDir)
  );

  // delete the files that were zipped
  await del(Path.resolve(buildDir, 'kibana'));
}
