'use strict';

// node & 3pp libs
const process = require('process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const https = require('https');
const Promise = require('bluebird');
const mkdir = Promise.promisify(fs.mkdir);
// AppCloud lib
const _ = require(path.join(__dirname, 'utils'));
const force = require('salesforce-alm-buildpack-dev');
// General
const DEBUG = true; // for development ONLY
console.log(process.env);
const VERBOSE = _.getEnvVarValue('SALESFORCE_BUILDPACK_VERBOSE', false, false, true);
const HEROKU_APP_NAME = _.getEnvVarValue('HEROKU_APP_NAME', true);
// FORCE_WORKSPACE=true if we're pushing source, false if deploying source
const IS_SALESFORCE_WORKSPACE = _.getEnvVarValue('SALESFORCE_WORKSPACE', true, true, true);
const IS_BYOO = _.getEnvVarValue('SALESFORCE_BYOO', false, false, true);
const SALESFORCE_SRC_PATH = _.getEnvVarValue('SALESFORCE_SRC_PATH', false, 'salesforce/src');
const SALESFORCE_URL_CONFIG_VAR_NAME = 'SALESFORCE_URL';
const SALESFORCE_DIR = _.getEnvVarValue('SALESFORCE_DIR', true);
const DEPLOY_TARGET_DIR = SALESFORCE_DIR;
const DEPLOY_ZIP_FILEPATH = path.join(DEPLOY_TARGET_DIR, 'unpackaged.zip');
const SALESFORCE_ORG = 'org@salesforce.com';
// force://${clientId}:${clientSecret}:${refreshToken}@${instanceUrl}
const SALESFORCE_URL_REGEX = /force:\/\/([A-Z0-9_\.]*):([A-Z0-9]*):([A-Z0-9_\.]*)@([\w-]+(\.[\w-]+)+\.?(:\d+)?)/ig;
const PUSH_SOURCE_CMD = {
    name: 'org:push',
    flags: {
        targetname: SALESFORCE_ORG,
        all: true,
        workspace: true,
        json: true
    }
};
// Retrieve source from org to generate zip for upstream deployment; lack of unpackaged param
// signifies auto-generation of package.xml based on workspace content
const MDAPI_RETRIEVE_CMD = {
    name: 'mdapi:retrieve',
    flags: {
        targetname: SALESFORCE_ORG,
        retrievetarget: DEPLOY_TARGET_DIR,
        all: true,
        // FIXME: convert to secs
        polltimeout: parseInt(_.getEnvVarValue('SALESFORCE_RETRIEVE_POLL_TIMEOUT_MS', false, 180 * 1000 /* 3 min */)),
        pollinterval: parseInt(_.getEnvVarValue('SALESFORCE_RETRIEVE_POLL_INTERVAL_MS', false, 10 * 1000 /* 10 sec */)),
        silent: true, // to quiet api output
        verbose: false, // for debugging
        json: true
    }
};
// Set deployroot (mdapi project) and/or zipfile (workspace project) when used
const MDAPI_DEPLOY_CMD = {
    name: 'mdapi:deploy',
    flags: {
        targetname: SALESFORCE_ORG,
        runtest: _.getEnvVarValue('SALESFORCE_DEPLOY_RUNTEST', false, ''),
        testlevel: _.getEnvVarValue('SALESFORCE_DEPLOY_TEST_LEVEL', false, ''),
        rollbackonerror: _.getEnvVarValue('SALESFORCE_DEPLOY_ROLLBACK_ON_ERROR', false, true),
        // FIXME: convert to secs
        polltimeout: parseInt(_.getEnvVarValue('SALESFORCE_DEPLOY_POLL_TIMEOUT_MS', false, 3 * 60 * 1000 /* 3 min */)),
        pollinterval: parseInt(_.getEnvVarValue('SALESFORCE_DEPLOY_POLL_INTERVAL_MS', false, 10 * 1000 /* 10 sec */)),
        silent: true, // to quiet api output
        verbose: false, // for debugging
        json: true
    }
};
// Test all Apex classes
const TEST_CMD = {
    name: 'apex:test',
    flags: {
        targetname: SALESFORCE_ORG,
        codecoverage: true,
        reporter: 'tap'
    }
};
// Add-on query config
const HEROKU_API = _.getEnvVarValue('HEROKU_API', false, 'api.heroku.com');
const HEROKU_API_TOKEN = _.getEnvVarValue('HEROKU_API_TOKEN', true);
const SALESFORCE_ADDON_NAME = _.getEnvVarValue('SALESFORCE_ADDON_NAME', false, 'salesforce' /* prod */);
// FIXME: convert to secs
const SALESFORCE_ADDON_POLL_TIMEOUT_MS = parseInt(_.getEnvVarValue('SALESFORCE_ADDON_POLL_TIMEOUT', false, 3 * 60 * 1000 /* 3 min */));
const SALESFORCE_ADDON_POLL_INTERVAL_MS = parseInt(_.getEnvVarValue('SALESFORCE_ADDON_POLL_INTERVAL', false, 10 * 1000 /* 10 sec */));

// custom URL set by Salesforce Add-on or by admin that enables connectivity to org
let salesforceUrl = _.getEnvVarValue(SALESFORCE_URL_CONFIG_VAR_NAME, false, undefined);
// Org config, accessToken, username, instance, etc
let orgConfig;
// if true, we're testing and must '#' for all non-TAP output log lines
let tapOnly = false;

//  F U N C T I O N S

// Prepare for push/deploy
const prepareEnv = function prepare(url) {
    if (!tapOnly) {
        _.info('');
        _.action('###   P R E P A R E');
    }

    return makeArtifactDir()
        .then(() => {
            return salesforceUrl ? Promise.resolve(salesforceUrl) : waitForOrgProvisioning();
        })
        .then(writeOrgConfig);
};

// Create artifact dir (SALESFORCE_DIR), okay if exists
const makeArtifactDir = function makeArtifactDir() {
    return new Promise((resolve, reject) => {
        mkdir(SALESFORCE_DIR)
            .then(() => resolve(SALESFORCE_DIR))
            .catch(error => {
                // It is ok if the directory already exist
                if (error.code === 'EEXIST') {
                    resolve(SALESFORCE_DIR);
                } else {
                    reject(error);
                }
            });
    });
};

// Wait for Salesforce Add-on to finish provisioning
const waitForOrgProvisioning = function waitForOrgProvisioning() {
    _.info(`Waiting for Salesforce Add-on to provision org (timeout: ${_.toSec(SALESFORCE_ADDON_POLL_TIMEOUT_MS)}s, interval: ${_.toSec(SALESFORCE_ADDON_POLL_INTERVAL_MS)}s)...`);

    if (salesforceUrl) {
        _.info(`Salesforce URL set to ${salesforceUrl}`);
        return Promise.resolve(salesforceUrl);
    }

    const start = (new Date()).getTime();
    let cnt = 0;
    let ticks = [];

    function pollConfigVars() {
        return Promise.try(() => {
                if (ticks.length > 80) {
                    ticks = [];
                }
                ticks.push('-');
                _.info(`${ticks.join('')}>`);
                return queryApi('GET', `/apps/${HEROKU_APP_NAME}/config-vars`);
            })
            .then(function(response) {
                if (!util.isNullOrUndefined(response)) {
                    if (DEBUG) _.info(`[DEBUG] Config vars response: ${response}`);
                    const configVars = JSON.parse(response);
                    if (!util.isNullOrUndefined(configVars[SALESFORCE_URL_CONFIG_VAR_NAME])) {
                        return configVars[SALESFORCE_URL_CONFIG_VAR_NAME];
                    }
                }

                // FIXME: move to setTimeout
                const duration = (new Date()).getTime() - start;
                if (duration > SALESFORCE_ADDON_POLL_TIMEOUT_MS) {
                    throw new Error(`Timeout while waiting for Salesforce Add-on to provision new org ('${SALESFORCE_URL_CONFIG_VAR_NAME}'): timeout: ${_.toSec(SALESFORCE_ADDON_POLL_TIMEOUT_MS)}s, waited ${_.toSec(duration)}s`);
                } else {
                    // query again
                    return Promise.try(() => {
                        return Promise.delay(SALESFORCE_ADDON_POLL_INTERVAL_MS)
                            .then(pollConfigVars);
                    });
                }
            });
    }

    return pollConfigVars()
        .then((result) => {
            salesforceUrl = result;
            _.info(`Obtained '${SALESFORCE_URL_CONFIG_VAR_NAME}' config var in ${_.toSec((new Date()).getTime() - start)}s`);
            return salesforceUrl;
        });
};

const queryApi = function queryApi(method, path) {
    const options = {
        host: HEROKU_API,
        path: path,
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.heroku+json; version=3',
            'Authorization': `Bearer ${HEROKU_API_TOKEN}`
        }
    };

    // return new pending promise
    return new Promise((resolve, reject) => {
            if (DEBUG) _.info(`${options.method}: ${options.host}${options.path}...`);
            const request = https.get(options, (response) => {
                if (response.statusCode < 200 || response.statusCode > 299) {
                    reject(new Error(`Failed to load API ${path}, status code ${response.statusCode}`));
                }

                const result = [];
                response.on('data', (chunk) => {
                    result.push(chunk)
                });
                response.on('end', () => {
                    resolve(result.join(''))
                });
            });

            request.on('error', (err) => {
                reject(err)
            })
        });
};

// Write SALESFORCE_URL to .appcloud to be consumed by appcloud module
const writeOrgConfig = function writeOrgConfig(salesforceUrl) {
    if (DEBUG && !tapOnly) _.info(`[DEBUG] ${SALESFORCE_URL_CONFIG_VAR_NAME}: ${salesforceUrl}`);
    orgConfig = getOrgConfigFromUrl(salesforceUrl);
    if (DEBUG && !tapOnly) _.info(`[DEBUG] Org config: ${JSON.stringify(orgConfig)}`);

    const OrgConfigApi = new force.scratchOrgApi();
    OrgConfigApi.setName(SALESFORCE_ORG);
    return OrgConfigApi.saveConfig(orgConfig)
        .then(() => {
            const orgConfigFilePath = force.util.getAppCloudFilePath(SALESFORCE_ORG + '.json');
            if (VERBOSE && !tapOnly) _.info(`Wrote '${orgConfig.username}' org config ${orgConfigFilePath}`);
        });
};

// Generate config object from SALESFORCE_URL
const getOrgConfigFromUrl = function getOrgConfigFromUrl(url) {
    const match = SALESFORCE_URL_REGEX.exec(url);
    if (match === null) {
        throw new Error(`Invalid SALESFORCE_URL: '${url}'`);
    }

    // w/o accessToken
    const config = {
        orgId: '00Dxx0000000000',
        accessToken: 'REFRESH_ME',
        refreshToken: match[3],
        instanceUrl: `https://${match[4]}`,
        username: 'org@salesforce.com',
        clientId: match[1],
        clientSecret: match[2],
        type : 'workspace'
    };

    return config;
};

// Push workspace source to workspace org
const pushSource = function pushSource() {
    _.info('');
    _.action('###   P U S H');

    const pushCmd = new force.push();

    if (VERBOSE) {
        _.info(`Push options: ${JSON.stringify(PUSH_SOURCE_CMD.flags)}`);
    }

    _.info(`Pushing workspace source to org '${orgConfig.username}' at ${orgConfig.instanceUrl}...`);
    const start = (new Date()).getTime();
    return pushCmd.validate(PUSH_SOURCE_CMD.flags)
        .bind(pushCmd)
        .then(pushCmd.execute)
        .then((result) => {
            _.info(`Pushed completed in ${_.toSec((new Date()).getTime() - start)}s`);

            return evalResult(PUSH_SOURCE_CMD.name, result)
        })
        .then((result) => {
            if (VERBOSE) {
                _.info(`Pushed source [${result.PushedSource.length}]:`);
                let paths = [];
                result.PushedSource.forEach(source => {
                    paths.push(`${_.LOG_INDENT}  ${source.path}`);
                });

                console.log(paths.join('\n'));
            }
        });
};

// Retrieve source from org to local zip
const retrieveZip = function retrieveZip() {
    _.info('');
    _.action('###   R E T R I E V E');

    const retrieveCmd = new force.retrieve();

    if (VERBOSE) {
        _.info('Retrieve options: ' + JSON.stringify(MDAPI_RETRIEVE_CMD.flags));
    }

    _.info(`Retrieving source metadata zip from org '${orgConfig.username}' at ${orgConfig.instanceUrl}...`);
    const start = (new Date()).getTime();
    return retrieveCmd.execute(MDAPI_RETRIEVE_CMD.flags)
        .then((result) => {
            _.info(`Retrieved completed in ${_.toSec((new Date()).getTime() - start)}s`);
            return evalResult(MDAPI_RETRIEVE_CMD.name, result)
        })
        .then((result) => {
            _.info(`Status: ${result.status}`);
            _.info(`Wrote retrieve zip to ${result.zipFilePath}.`);

            if (VERBOSE) {
                result.fileProperties.sort((file1, file2) => {
                    const fileName1 = file1.fullName.toUpperCase();
                    const fileName2 = file2.fullName.toUpperCase();
                    if (fileName1 < fileName2) return -1;
                    if (fileName1 > fileName2) return 1;
                    return 0;
                });

                let paths = [];
                result.fileProperties.forEach(file => {
                    paths.push(`${_.LOG_INDENT}  ${file.fullName}`);
                });

                _.info(`Id:  ${result.id}`);
                _.info(`Components retrieved [${result.fileProperties.length}]:`);
                console.log(paths.join('\n'));
            }
        });
};

// Deploy source root or zip to workspace org
const deploy = function deploy(addtlDeployOptions) {
    _.info('');
    _.action('###   D E P L O Y');

    if (util.isNullOrUndefined(addtlDeployOptions)) {
        throw new Error('Deploy options (deployroot or zipfile) not provided');
    }

    const deployCmd = new force.deploy();
    const deployOptions = Object.assign(MDAPI_DEPLOY_CMD.flags, addtlDeployOptions);
    if (VERBOSE) {
        _.info('Deploy options: ' + JSON.stringify(deployOptions));
    }

    _.info(`Deploying ${(addtlDeployOptions.deployroot ? 'source' : 'zip')} to org '${orgConfig.username}' at ${orgConfig.instanceUrl} (timeout: ${deployOptions.polltimeout}ms, interval: ${deployOptions.pollinterval}ms)...`);

    const start = (new Date()).getTime();
    return deployCmd.execute(deployOptions)
        .then((result) => {
            _.info(`Deploy completed in ${_.toSec((new Date()).getTime() - start)}s`);
            return evalResult(MDAPI_DEPLOY_CMD.name, result)
        })
        .then((result) => {
             _.action(`Status:  ${result.status}`);
             _.info(`Id:  ${result.id}`);
             _.info(`Completed:  ${result.completedDate}`); // TODO: convert to locale
             _.info(`Component errors:  ${result.numberComponentErrors}`);
             _.info(`Components deployed:  ${result.numberComponentsDeployed}`);
             _.info(`Components total:  ${result.numberComponentsTotal}`);
             _.info(`Tests errors:  ${result.numberTestErrors}`);
             _.info(`Tests completed:  ${result.numberTestsCompleted}`);
             _.info(`Tests total:  ${result.numberTestsTotal}`);

            if (VERBOSE) {
                if (result.details) {
                    if (result.details.componentSuccesses) {
                        result.details.componentSuccesses.sort((file1, file2) => {
                            const fileName1 = file1.fullName.toUpperCase();
                            const fileName2 = file2.fullName.toUpperCase();
                            if (fileName1 < fileName2) return -1;
                            if (fileName1 > fileName2) return 1;
                            return 0;
                        });

                        let paths = [];
                        result.details.componentSuccesses.forEach(source => {
                            paths.push(`${_.LOG_INDENT}  ${source.fullName}`);
                        });

                        _.info(`Deployment successes [${result.details.componentSuccesses.length}]:`);
                        console.log(paths.join('\n'));
                    }

                    if (result.details.componentFailures) {
                        result.details.componentFailures.sort((file1, file2) => {
                            const fileName1 = file1.fullName.toUpperCase();
                            const fileName2 = file2.fullName.toUpperCase();
                            if (fileName1 < fileName2) return -1;
                            if (fileName1 > fileName2) return 1;
                            return 0;
                        });

                        let paths = [];
                        result.details.componentFailures.forEach(source => {
                            paths.push(`${_.LOG_INDENT}  ${source.fullName}`);
                        });

                        _.info(`Deployment failures [${result.details.componentFailures.length}]:`);
                        console.log(paths.join('\n'));
                    }
                }
            }
        })
        .catch(err => {
            if (err && err.message && err.message.startsWith('Polling time out')) {
                _.warning(`Deploy timed out in ${_.toSec((new Date()).getTime() - start)}s`);
            }

            throw err;
        });
};

// Inspect command result
const evalResult = function evalResult(cmd, result) {
    if (!result || result === null) {
        throw new Error(`No result from ${cmd.name}`);
    }

    if (result.status && 'error' == result.status) {
        throw new Error(result);
    }

    return Promise.resolve(result);
};

/**
 * TODO
 */
const compile = function compile() {
    return Promise.resolve()
        .then(() => {
            if (!IS_BYOO) {
                _.info(`Found Scratch Org app.`);
                if (IS_SALESFORCE_WORKSPACE) {
                    _.info(`Found Force.com workspace project.`);
                    return prepareEnv()
                        .then(pushSource)
                        .then(retrieveZip)
                        .then(() => {
                            try {
                                const stat = fs.statSync(DEPLOY_ZIP_FILEPATH);
                                _.info(`Verified deployment artifact: ${DEPLOY_ZIP_FILEPATH} (${_.toKb(stat.size)} KB)`);
                            }
                            catch (err) {
                                if (err.code === 'ENOENT') {
                                    throw new Error(`Deploy zip should have been generated.  Zip not found: ${DEPLOY_ZIP_FILEPATH}`);
                                } else {
                                    throw err;
                                }
                            }
                        });
                } else {
                    _.info(`Found Force.com Metadata API project.  Deployment done in release phase script or Procfile.`);
                }
            } else {
                _.info(`Found BYOO app.  Deployment done in release phase script or Procfile.`);
            }
        });
};

/**
 * TODO
 */
const release = function release() {
    return Promise.resolve()
        .then(() => {
            try {
                return fs.statSync(DEPLOY_ZIP_FILEPATH);
            }
            catch (err) {
                if (err.code === 'ENOENT') {
                    return undefined;
                } else {
                    throw err;
                }
            }
        })
        .then((stats) => {
            if (IS_BYOO) {
                if (!stats) {
                    throw new Error(`Found BYOO, but no deployment zip ${DEPLOY_ZIP_FILEPATH}`);
                }

                _.info(`Found BYOO app.`);

                return prepareEnv()
                    .then(() => {
                        if (stats) {
                            _.info(`Found deployment artifact: ${DEPLOY_ZIP_FILEPATH} (${_.toKb(stats.size)} KB)`);
                            return deploy({
                                zipfile: DEPLOY_ZIP_FILEPATH
                            });
                        } else {
                            _.info(`Deployment artifact: ${DEPLOY_ZIP_FILEPATH} (${_.toKb(stats.size)} KB)`);
                            return deploy({
                                deployroot: SALESFORCE_SRC_PATH,
                                zipfile: DEPLOY_ZIP_FILEPATH
                            });
                        }
                    });
            } else {
                _.info(`Found Scratch Org app.`);

                if (IS_SALESFORCE_WORKSPACE) {
                    _.info(`Found Force.com workspace project.`);

                    if (!stats) {
                        throw new Error(`Deploy zip not found: ${DEPLOY_ZIP_FILEPATH}`);
                    }

                    _.info(`Verified deployment artifact: ${DEPLOY_ZIP_FILEPATH} (${_.toKb(stats.size)} KB)`);
                    _.info(`Source already pushed in compile phase.`);

                    return Promise.resolve();
                } else {
                    _.info(`Found Force.com Metadata API project.`);

                    // REVIEWME: project root should come from config var
                    return deploy({
                        deployroot: SALESFORCE_SRC_PATH,
                        zipfile: DEPLOY_ZIP_FILEPATH
                    });
                }
            }
        });
};

const test = function test() {
    const testCmd = new force.test();
    return prepareEnv()
        .then(() => {
            return testCmd.execute(TEST_CMD.flags);
        });
};

const main = function main() {
    // assume success until otherwise
    process.exitCode = 0;

    const start = (new Date()).getTime();
    return Promise.resolve()
        .then(() => {
            const invokePhase = process.argv[2];
            if (!invokePhase) {
                throw new Error('Phase parameter not provided.  Valid phases are \'compile\' or \'release\'');
            }

            if (invokePhase === 'compile') {
                return compile()
            } else if (invokePhase === 'release') {
                return release()
            } else if (invokePhase === 'test') {
                tapOnly = true;  // just output TAP test results
                return test()
            } else {
                throw new Error(`Illegal phase ${invokePhase}.  Valid phases are 'compile' or 'release' or 'test'`);
            }
        })
        .catch(err => {
            process.exitCode = 1;
            _.error(VERBOSE ? err.stack : err.message);
        })
        .finally(() => {
            const done = `${(process.exitCode === 0 ? 'SUCCESS!' : 'FAILED!')}  Completed in ${_.toSec((new Date()).getTime() - start)}s`;
            if (!tapOnly) {
                _.info('');
                _.action(`${done}`);
            } else {
                console.log(`# ${done}`);
            }

            // shell that executed node should see the exit code
            process.exit();
        });

};

// go!!!!
return main();
