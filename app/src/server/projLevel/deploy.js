import { createMachine, inspect, ssh } from '../dockerAPI/machine';
import { coroutine as co } from 'bluebird';
import { writeFile } from '../utils/utils';
import { containerCreate } from '../dockerAPI/docker';
import * as rsync from './rsync';
import defaultConfig from '../appLevel/defaultConfig';
import { readConfig } from '../appLevel/appConfig';
import { loadProject, writeProj } from './projConfig';
import { containerObj, createRemoteNetwork } from './containerMgmt';
import {
  FAILED_TO_CREATE_DOCKERFILE,
  FAILED_TO_SYNC_TO_REMOTE,
  FAILED_TO_BUILD_SERVER_IMAGE,
  NO_DOTOKEN,
} from '../appLevel/errorMsgs';

const createRemoteObj = (cleanName, basePath) => ({
  cleanName,
  basePath,
  machine: `dockdev-${cleanName}`,
  ipAddress: '',
  containers: [],
  counter: 0,
  status: 0,
});

/**
 * setRemoteServerParams() returns an object with the image, project path, network mode,
 * and working dir
 * based on the passed in image and project uuid
 *
 * @param {String} image
 * @param {String} uuid
 * @return {Object} returns an object with the image, project path, network mode, and working dir
 */
export const setRemoteServerParams = (container, remoteObj) => ({
  image: container.image,
  name: container.name,
  Env: [
    `VIRTUAL_HOST=${remoteObj.ipAddress}`,
  ],
  HostConfig: {
    NetworkMode: container.cleanName,
  },
});

/**
 * setDbParams() returns an object with the networkMode
 * based on the passed in image and project uuid
 *
 * @param {String} image
 * @param {String} uuid
 * @return {Object} returns an object with the networkMode
 */
export const setRemoteDbs = (container) => ({
  image: container.image,
  name: container.name,
  HostConfig: {
    NetworkMode: container.cleanName,
  },
});

/**
 * setProxyParams() returns an object with the appropriate volume commands
 *
 * @param {String} image
 * @param {String} uuid
 * @return {Object} returns an object
 */
export const setProxyParams = (container) => ({
  image: container.image,
  name: container.name,
  HostConfig: {
    Binds: ['/var/run/docker.sock:/tmp/docker.sock:ro'],
    PortBindings: { ['80/tcp']: [{ HostPort: '80' }] },
  },
  ExposedPorts: {
    ['80/tcp']: {},
  },
});

/**
 * createDroplet() returns a promise to create a droplet on DigitalOcean
 * based on the dropletName and token.  Optional arguments are accepted.
 * See https://docs.docker.com/machine/drivers/digital-ocean/ for details.
 *
 * @param {String} dropletName
 * @param {String} token
 * @param {...String} options
 * @return {} returns a promise to create a droplet on DigitalOcean
 */
export const createDroplet = (dropletName, token, ...args) =>
  createMachine('--driver digitalocean',
    `--digitalocean-access-token=${token}`,
    ...args,
    dropletName
  );

/**
 * createDockerfile() creates a Dockerfile in the project base path
 *
 * @param {Object} containers
 * @param {String} basePath
 * @return {} returns a promise that is either true or throws an error
 */
export const createDockerfile = co(function *g(containers, basePath) {
  try {
    const server = containers.filter(cont => cont.server)[0];
    const dockerFile =
      `From ${server.image}\n` +
      'COPY . /app\n' +
      'WORKDIR /app\n' +
      'RUN ["npm", "install", "--production"]\n' +
      'EXPOSE 3000\n' +
      'CMD ["npm", "start"]';
    yield writeFile(`${basePath}/Dockerfile`, dockerFile);
    return true;
  } catch (e) {
    throw FAILED_TO_CREATE_DOCKERFILE;
  }
});

/**
 * syncFilesToRemote() syncs the project directory to the remote machine
 *
 * @param {String} basePath
 * @param {String} machineName
 * @return {} returns a promise that is either true or throws an error
 */
export const syncFilesToRemote = co(function *g(remoteObj, local = false) {
  const cleanPath = rsync.cleanFilePath(remoteObj.basePath);
  const dest = local ? '/home/docker' : defaultConfig.remoteDest;
  try {
    const machineInfo = rsync.selectSSHandIP(yield inspect(remoteObj.machine));
    const remoteRsyncArgs =
      rsync.createRemoteRsyncArgs(`${cleanPath}/*`, dest, machineInfo, local);
    yield rsync.rsync(remoteRsyncArgs);
    return { ...remoteObj, ipAddress: machineInfo.IPAddress };
  } catch (e) {
    throw FAILED_TO_SYNC_TO_REMOTE;
  }
});

/**
 * buildServerImage() creates the server image on the remote host
 *
 * @param {Object} remoteObj
 * @return {} returns a promise that is either true or throws an error
 */
export const buildServerImage = (remoteObj) =>
  ssh(remoteObj.machine, `docker build -t dockdev/${remoteObj.cleanName}:${remoteObj.counter} .`)
    .then(() => true);
    // .catch(() => {throw FAILED_TO_BUILD_SERVER_IMAGE;});

/**
 * initRemote() provisions the droplet, creates a network, and returns the base remoteObj
 *
 * @param {Object} remoteObj
 * @return {} returns a promise that is either true or throws an error
 */
export const initRemote = co(function *g(cleanName, path) {
  // read the configuration file for the digital ocean token
  const configPath = defaultConfig.configPath();
  const readConfigFile = yield readConfig(configPath);
  const DOToken = readConfigFile.DOToken;
  if (!DOToken) throw NO_DOTOKEN;
  // create initial remote config object
  const remoteObj = createRemoteObj(cleanName, path);
  // read existing project configuration
  const projObj = yield loadProject(path);
  // provision the droplet
  yield createDroplet(remoteObj.machine, DOToken);
  // write the project object into the dockdev.json file
  yield writeProj(projObj);
  // setup the docker network for the project
  yield createRemoteNetwork(remoteObj);
  return remoteObj;
});


/**
 * addNginxContainer() pushes the appopriate nginx container to the array so that is is pulled
 *
 * @param {Array} containers
 * @param {Object} remoteObj
 * @return {} returns a new version of the container array with nginx included
 */
export const addNginxContainer = (containers, remoteObj) => {
  const nginx = containerObj(remoteObj.cleanName, {
    name: 'jwilder/nginx-proxy',
    server: false,
  });
  nginx.nginx = true;
  nginx.name = 'proxy';
  return [...containers, nginx];
};

/**
 * remoteServerObj() returns the base object for the remote server container
 *
 * @param {String} cleanName
 * @param {Object} imageObj
 * @return {Object} returns a baseline container object
 */
export const remoteServerObj = (remoteObj) => ({
  cleanName: remoteObj.cleanName,
  image: `dockdev/${remoteObj.cleanName}:${remoteObj.counter}`,
  dockerId: '',
  name: `server${remoteObj.counter}`,
  server: true,
  status: 'pending',
  machine: remoteObj.machine,
});

const getRemoteConfig = (container, remoteObj) => {
  if (container.server) return setRemoteServerParams(container, remoteObj);
  if (container.nginx) return setProxyParams(container);
  return setRemoteDbs(container);
};

export const createRemoteContainer = co(function *g(container, remoteObj) {
  const config = getRemoteConfig(container, remoteObj);
  const dockCont = yield containerCreate(remoteObj.machine, config);
  return { ...container, dockerId: dockCont.Id, machine: remoteObj.machine };
});


// const basePath = join(__dirname, '..', '..', '..', '..', 'example-deploy', 'deploy');
//
// syncFilesToRemote(basePath, 'test2', true)
//   .then(val => console.log(val))
//   .catch(err => console.log(err));


// /**
//  * getDbNames() returns the images and names of all the database in the project
//  * based on the passed in project object
//  *
//  * @param {Object} projObj
//  * @return {Array} dbImageNames
//  */
// function getDbNames(projObj) {
//   const dbImageNames = [];
//   for (const contId in projObj.containers) {
//     if (!projObj.containers[contId].server) {
//       dbImageNames.push(projObj.containers[contId].image);
//       dbImageNames.push(projObj.containers[contId].name);
//     }
//   }
//   return dbImageNames;
// }
//
// /**
//  * pullImagesOcean() returns true after pulling and running all the db images on DigitalOcean
//  * based on the passed in digital ocean machine neame and array of db images and names
//  *
//  * @param {String} dropletMachName
//  * @param {Array} dbNamesArr
//  * @return {Boolean} true
//  */
// const pullImagesOcean = co(function *g(dropletMachName, dbNamesArr) {
//   for (let i = 0; i < dbNamesArr.length; i += 2) {
//     try {
//       yield ssh(dropletMachName, `docker run -d --name ${dbNamesArr[i + 1]} ${dbNamesArr[i]}`);
//     } catch (e) {
//       console.log(e);
//     }
//   }
//   return true;
// });
//
// /**
//  * buildDockerFile() returns true after creating a Dockerfile
//  *
//  * @return {Boolean} true
//  */
// const buildDockerFile = co(function *g() {
//   // what if they deploy twice and it already exists??

//   return true;
// });
//
// /**
//  * deployToOcean() returns true after walking through a sequence of events to deploy
//  * a project to digital ocean
//  * based on the passed in project object, remote machine name, and access token
//  *
//  * @param {Object} projObj
//  * @param {String} accessToken
//  * @return {Boolean} true
//  */
// export const deployToOcean = co(function *g(projObj, accessToken) {
//   const remoteMachName = projObj.projectName.replace(' ', '_');
//   const Token = storeOceanToken(accessToken);
//   yield dropletOnOcean(Token, remoteMachName);
//   const dbNamesArray = getDbNames(projObj);
//   yield pullImagesOcean(remoteMachName, dbNamesArray);
//   yield buildDockerFile();
//   const remoteSync = generateRsync(projObj, 'remoteMachine');
//   yield remoteSync;
//   yield ssh(remoteMachName, 'docker build ./tmp');
//   return true;
// });
