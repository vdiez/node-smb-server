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

var util = require('util');
var Path = require('path');
var fs = require('fs');

var logger = require('winston').loggers.get('spi');
var perflog = require('winston').loggers.get('perf');
var async = require('async');

var Tree = require('../../spi/tree');
var FSFile = require('./file');
var SMBError = require('../../smberror');
var utils = require('../../utils');
var mkdirp = require('mkdirp');
let ObjectID = require('mongodb').ObjectID;

let protoclients = require('protoclients');
let request = require('got');

/**
 * Creates an instance of Tree.
 *
 * @constructor
 * @this {FSTree}
 * @param {FSShare} share parent share
 */
var FSTree = function (share) {
  if (!(this instanceof FSTree)) {
    return new FSTree(share);
  }

  this.share = share;

  Tree.call(this, this.share.config);
};

// the FSTree prototype inherits from Tree
util.inherits(FSTree, Tree);

FSTree.prototype.get_roots = function () {
  return request({
    url: "https://127.0.0.1/roots/list",
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': this.token
    },
    https: {rejectUnauthorized: false},
    timeout: 1000,
    retry: 0
  })
      .then(response => {
        if (!response || !response.body) throw "No answer from server";
        let body = JSON.parse(response.body);
        //winston.debug(body);
        if (!body.roots) throw "No roots returned";
        this.roots = body.roots;
        this.roots_by_name = (this.roots || []).reduce((obj, root) => {obj[root.name_lower] = root;return obj;}, {});
      })
};

FSTree.prototype.get_storage = function (storage_id) {
  return this.share.config.db.collection(this.share.config.db_storages).findOne({_id: new ObjectID(storage_id)});
}

FSTree.prototype.resolve_path = function (dir = '.') {
  let dir_parts = Path.join(this.share.path, dir).split('/');
  dir_parts.shift(); //discard empty string before root /
  let root_name = dir_parts.shift();
  return this.get_roots()
      .then(() => {
        if (root_name && this.roots_by_name.hasOwnProperty(root_name)) {
          if (dir_parts.length) return {root: this.roots_by_name[root_name], uri: dir_parts.join(path.posix.sep)};
          return {root: this.roots_by_name[root_name], uri: ""};
        }
        return {};
      })
}

/**
 * Create a new FSFile instance for use by the tree.
 * @param name The name of the file to create.
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {FSFile} cb.file FSFile instance
 */
FSTree.prototype.createFileInstance = function (name, cb) {
  FSFile.createInstance(name, this, cb);
};

//---------------------------------------------------------------------< Tree >

/**
 * Test whether or not the specified file exists.
 *
 * @param {String} name file name
 * @param {Function} cb callback called with the result
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {Boolean} cb.exists true if the file exists; false otherwise
 */
FSTree.prototype.exists = function (name, cb) {
  logger.debug('[%s] tree.exists %s', this.share.config.backend, name);
  perflog.debug('%s Tree.exists.fs.stat', name);
  this.resolve_path(name)
      .then(({root, uri}) => {
        if (root) {
          return this.get_storage(root.storage_id)
              .then(storage => {

                let connection = protoclients({params: storage, logger: logger, protocol: storage.protocol})
                return connection.stat(path.posix.join(root.dirname, uri), storage)
                    .catch(err => connection.stat(path.posix.join(root.dirname, '.tmp', uri), storage))
                    .then(() => cb(null, true))
                    .catch(err => cb(null, false))
              });
        }
        return {
          name: '/',
          isDirectory: () => true,
          mode: 511,
          mtime: new Date()
        };
      });
};

/**
 * Open an existing file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called with the opened file
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file opened file
 */
FSTree.prototype.open = function (name, cb) {
  logger.debug('[%s] tree.open %s', this.share.config.backend, name);
  this.createFileInstance(name, cb);
};

/**
 * List entries, matching a specified pattern.
 *
 * @param {String} pattern pattern
 * @param {Function} cb callback called with an array of matching files
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File[]} cb.files array of matching files
 */
FSTree.prototype.list = function (pattern, cb) {
  logger.debug('[%s] tree.list %s', this.share.config.backend, pattern);
  var parentPath = utils.getParentPath(pattern) || '';
  var realParentPath = Path.join(this.share.path, parentPath);
  var filter = utils.getPathName(pattern);

  // list will receive two types of patterns:
  // 1. request all items from a directory. sample: /some/directory/*
  // 2. request for a single item. sample: /some/directory
  // the difference is the inclusion of the asterisk at the end of the pattern. for #1, do a readdir of the
  // parent directory. for #2, just return the single item if it exists. for #2, avoid using readdir so that the
  // entire directory doesn't need to be read for just a single file

  var self = this;
  function evaluateFilter(next) {
    if (filter === '*') {
      // wildcard specified
      perflog.debug('%s Tree.list.fs.readdir', pattern);
      fs.readdir(realParentPath, function (err, files) {
        next(err ? SMBError.fromSystemError(err, 'cannot list pattern due to unexpected error ' + pattern) : null, files);
      });
    } else {
      // file name specified
      self.exists(pattern, function (err, exists) {
        next(err, exists ? [ filter ] : []);
      });
    }
  }

  function createFileInstances(names, next) {
    async.reduce(names, [],
      function (memo, name, callback) {
        self.createFileInstance(Path.join(parentPath, name), function (err, file) {
          if (err) {
            logger.error('[%s] tree.list %s: unexpected error while attempting to include %s in list', self.share.config.backend, pattern, name, err);
          } else {
            memo.push(file);
          }
          logger.debug('[%s] tree.list %s > %d', self.share.config.backend, pattern, memo.length);
          callback(null, memo);
        });
      },
      next
    );
  }

  async.waterfall([ evaluateFilter, createFileInstances ], cb);
};

/**
 * Create a new file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file created file
 */
FSTree.prototype.createFile = function (name, cb) {
  logger.debug('[%s] tree.createFile %s', this.share.config.backend, name);
  var self = this;
  var filePath = Path.join(this.share.path, name);
  mkdirp(utils.getParentPath(filePath), function (err) {
    if (err) {
      cb(err);
    } else {
      perflog.debug('%s Tree.createFile.fs.open', name);
      fs.open(filePath, 'wx', function (err, fd) {
        if (err) {
          cb(SMBError.fromSystemError(err, 'cannot create file due to unexpected error ' + name));
        } else {
          perflog.debug('%s Tree.createFile.fs.close', name);
          fs.close(fd, function (err) {
            if (err) {
              cb(SMBError.fromSystemError(err, 'cannot close file due to unexpected error ' + name));
            } else {
              self.createFileInstance(name, cb);
            }
          });
        }
      });
    }
  });
};

/**
 * Create a new directory.
 *
 * @param {String} name directory name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file created directory
 */
FSTree.prototype.createDirectory = function (name, cb) {
  logger.debug('[%s] tree.createDirectory %s', this.share.config.backend, name);
  var self = this;
  mkdirp(Path.join(this.share.path, name), function (err) {
    if (err) {
      cb(SMBError.fromSystemError(err,'cannot create directory due to unexpected error ' + name));
    } else {
      self.createFileInstance(name, cb);
    }
  });
};

/**
 * Delete a file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
FSTree.prototype.delete = function (name, cb) {
  logger.debug('[%s] tree.delete %s', this.share.config.backend, name);
  perflog.debug('%s Tree.delete.fs.unlink', name);
  fs.unlink(Path.join(this.share.path, name), SMBError.systemToSMBErrorTranslator(cb, 'cannot delete file due to unexpected error ' + name));
};

/**
 * Delete a directory. It must be empty in order to be deleted.
 *
 * @param {String} name directory name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
FSTree.prototype.deleteDirectory = function (name, cb) {
  logger.debug('[%s] tree.deleteDirectory %s', this.share.config.backend, name);
  perflog.debug('%s Tree.deleteDirectory.fs.rmdir', name);
  var toDelete = Path.join(this.share.path, name);
  if (toDelete && toDelete != '/') {
    fs.rmdir(toDelete, SMBError.systemToSMBErrorTranslator(cb));
  } else {
    cb(SMBError.fromSystemError({message: 'cannot delete root directory'}));
  }
};

/**
 * Rename a file or directory.
 *
 * @param {String} oldName old name
 * @param {String} newName new name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
FSTree.prototype.rename = function (oldName, newName, cb) {
  logger.debug('[%s] tree.rename %s to %s', this.share.config.backend, oldName, newName);
  perflog.debug('%s Tree.rename.fs.rename %s', oldName, newName);
  fs.rename(Path.join(this.share.path, oldName), Path.join(this.share.path, newName), SMBError.systemToSMBErrorTranslator(cb, 'cannot rename due to unexpected error ' + oldName + ' > ' + newName));
};

/**
 * Disconnect this tree.
 *
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
FSTree.prototype.disconnect = function (cb) {
  logger.debug('[%s] tree.disconnect', this.share.config.backend);
  // there's nothing to do here
  process.nextTick(function () { cb(); });
};

module.exports = FSTree;
