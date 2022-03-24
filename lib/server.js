/*
 *  Copyright 2015 Adobe Systems Incorporated. All rights reserved.
 *  This file is licensed to you under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License. You may obtain a copy
 *  of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software distributed under
 *  the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 *  OF ANY KIND, either express or implied. See the License for the specific language
 *  governing permissions and limitations under the License.
 */

'use strict';

let mongodb = require('mongodb');

var async = require('async');
var logger = require('winston').loggers.get('default');

var actions = [
  readConfiguration,
  setupServer,
  startServer
];

async.waterfall(actions, onStarted);

process.on('uncaughtException', function (err) {
  logger.error('encountered uncaught exception at process level. exiting', err);
  process.exit(1);
});

// Read a config.json file from the file system, parse it and pass it to the next function in the
// chain.

function readConfiguration(done) {
  let config = require('../config');
  return mongodb.MongoClient.connect(new mongodb.Server(config.db_host, config.db_port)).then(client => {
    config.db = client.db(config.db_name);
    done(null, config);
  });

}

// Setup the server

function setupServer(config, done) {
  // custom authenticator? null for using default authenticator
  var authenticator = new (require('../my_auth'))();

  // require smbserver.js here in order to don't interfere with the logger setup in the previous step
  var SMBServer = require('./smbserver');
  done(null, config, new SMBServer(config, authenticator));
}

// Start the server

function startServer(config, server, done) {
  var port = config && config.listen && config.listen.port || 445;
  var host = config && config.listen && config.listen.host || '0.0.0.0';

  server.start(port, host, function () {
    done(null, config);
  });
  server.on('error', done);
}

// Handle errors during initialization.

function onStarted(err) {
  if (err) {
    logger.error('error during startup, exiting... : %s', err.message);
    process.exit(1);
  }
}


