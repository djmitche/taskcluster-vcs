import { ArgumentParser } from 'argparse';
import repoCheckout from './repo-checkout';
import vcsRepo from '../vcs/repo';
import temp from 'promised-temp';
import render from 'json-templater/string';
import assert from 'assert';
import fs from 'mz/fs';
import fsPath from 'path';
import urlAlias from '../vcs/url_alias';
import createHash from '../hash';
import run from '../vcs/run';

import * as clitools from '../clitools';

async function createTar(config, cwd, project) {
  let dest = temp.path();
  let projectPath =
    fsPath.join('.repo', 'projects', `${project.path}.git`);

  let objectsPath =
    fsPath.join('.repo', 'project-objects', `${project.name}.git`);

  assert(
    await fs.exists(fsPath.join(cwd, projectPath)),
    `project files must exist (${projectPath})`
  );

  assert(
    await fs.exists(fsPath.join(cwd, objectsPath)),
    `project files must objects (${objectsPath})`
  );

  let source = [projectPath, objectsPath].join(' ')

  await run(render(config.repoCache.compress, { source, dest }), {
    cwd,
  });

  return dest;
}

async function uploadTar(config, source, url) {
  await run(render(config.repoCache.uploadTar, {
    source, url
  }));
}

async function createArtifact(tcConfig, queue, name) {
  return await queue.createArtifact(
    tcConfig.taskId,
    tcConfig.runId,
    name,
    {
      storageType: 's3',
      expires: tcConfig.expires,
      contentType: 'application/x-tar'
    }
  );
}

async function createIndex(tcConfig, index, name) {
  let namespace = `${tcConfig.namespace}.${name}`;
  await index.insertTask(namespace, {
    taskId: tcConfig.taskId,
    // Date.now is used for convenience we should determine other methods of
    // marking rank including number of commits, etc...
    rank: Date.now(),
    data: {},
    expires: tcConfig.expires
  });
}

export default async function main(config, argv) {
  let parser = new ArgumentParser({
    prog: 'tc-vcs create-repo-cache',
    version: require('../../package').version,
    addHelp: true,
    description: `
      Clones (using the cache if possible) and updates the given repository to
      the current tip of the default branch. After clone/update the index will
      be updated to point to the given task and rank updated to current utc time.

      This primary way this is different from create-clone-cache is the use of
      repo-checkout and the caching of _only_ the .repo folder...
    `.trim()
  });

  // Shared arguments....
  ['taskId', 'runId', 'expires', 'proxy'].forEach((name) => {
    clitools.arg[name](parser);
  });

  parser.addArgument(['--namespace'], {
    defaultValue: 'tc-vcs.v1.repo-project',
    help: 'Taskcluster Index namespace'
  });

  parser.addArgument(['-m', '--manifest'], {
    dest: 'manifest',
    help: 'Manifest path',
    required: true
  });

  parser.addArgument(['-b', '--branch'], {
    dest: 'branch',
    defaultValue: 'master',
    help: 'branch argument to pass (-b) to repo init'
  });

  parser.addArgument(['url'], {
    help: 'url which to clone from'
  });

  // configuration for clone/update....
  let args = parser.parseArgs(argv);
  let workspace = temp.path('tc-vcs-create-repo-cache');

  // Clone and update cache...
  await repoCheckout(config, [
    workspace, args.url,
    '--namespace', args.namespace,
    '--manifest', args.manifest,
    '--branch', args.branch
  ]);

  let queue = clitools.getTcQueue(args.proxy);
  let index = clitools.getTcIndex(args.proxy);

  // Get a list of the projects so we can build the tars...
  let projects = await vcsRepo.list(workspace);

  // Configs for the taskcluster helper functions
  let tcConfig = {
    taskId: args.taskId,
    runId: args.runId,
    namespace: args.namespace,
    branch: args.branch,
    expires: args.expires
  };

  // Tar files to remove after this operation...
  let tarsToRemove = [workspace];

  await Promise.all(projects.map(async (project) => {
    let alias = urlAlias(project.remote);
    let artifactName = `public/${alias}/${args.branch}.tar.gz`;
    let indexName = createHash(`${alias}/${args.branch}`);

    // Create the tar and artifact in parallel both can be slow...
    let [tarPath, artifact] = await Promise.all([
      createTar(config, workspace, project),
      createArtifact(tcConfig, queue, artifactName)
    ]);

    // Keep track of the tar _before_ we attempt to upload (which may fail)
    tarsToRemove.push(tarPath);
    await uploadTar(config, tarPath, artifact.putUrl);
    await createIndex(tcConfig, index, indexName);
  }));

  // The tar(s) may be huge so deleting them can be useful in a non-docker
  // environment which is not self-contained.
  if (tarsToRemove.length) {
    await run(`rm -Rf ${tarsToRemove.join(' ')}`);
  }
}
