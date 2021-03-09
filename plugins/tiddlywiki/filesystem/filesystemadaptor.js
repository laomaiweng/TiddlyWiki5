/*\
title: $:/plugins/tiddlywiki/filesystem/filesystemadaptor.js
type: application/javascript
module-type: syncadaptor

A sync adaptor module for synchronising with the local filesystem via node.js APIs

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

// Get a reference to the file system
var fs = $tw.node ? require("fs") : null,
	path = $tw.node ? require("path") : null;
try {
	var git = $tw.node ? require("nodegit") : null;
	// Git state/configuration
	var gitState = {
		op: null,
		repo: null,
		lastSaved: null,
		doPush: true,
		pushTimeoutTimer: null,
		pushIntervalTimer: null,
		config: {
			sig: null,
			commitDrafts: false,
			remote: {
				name: 'origin',
				// Use this to push some time after changes are committed; new changes reset the timeout (this lets a slew of changes accumulate before getting pushed)
				pushTimeout: 60, // in seconds (<= 0 to disable)
				// Use this to push at regular intervals; new changes don't alter the interval (this is useful if the remote is not always reachable)
				pushInterval: 60*60, // in seconds (<= 0 to disable)
				agentAuth: true,
				pubkeyAuth: null, // [pubkey, privkey]
			},
		},
	}
	//TODO: load config from somewhere?
	gitState.op = git.Repository.open(".").then(async function(repo) {
		gitState.repo = repo;
		if (!gitState.config.sig) {
			gitState.config.sig = await repo.defaultSignature();
		}
		$tw.syncer.logger.log("Git repository detected.");
		if (gitState.config.remote.pushInterval > 0) {
			// Schedule push on interval
			gitState.pushIntervalTimer = setInterval(gitPushRepo, gitState.config.remote.pushInterval*1000);
		}
		// Do an initial push if configured to push at all
		if (gitState.config.remote.pushTimeout > 0 || gitState.config.remote.pushInterval > 0) {
			await gitPushRepo();
		}
	}).catch(function(err) {
		if (!gitState.repo) {
			$tw.syncer.logger.log("No Git repository detected.");
		} else {
			$tw.syncer.logger.log("Git initialization failed: "+err);
		}
	});
} catch(err) {
	git = null;
}

// Convert absolute path to repository-relative path
function gitFilePath(filepath) {
	var relative = path.relative(".", filepath);
	return relative.split(path.sep).join(path.posix.sep);
}

function gitCommitChanges(tiddlerTitle, addedFiles, deletedFiles, message, isDraft) {
	if (addedFiles.length == 0 && deletedFiles.length == 0)
		return;
	if (isDraft && !gitState.config.commitDrafts)
		return;
	gitState.op = gitState.op.then(async function() {
		// Convert into repository paths
		addedFiles = addedFiles.map(gitFilePath);
		deletedFiles = deletedFiles.map(gitFilePath);
		// Update the index
		var index = await gitState.repo.refreshIndex();
		var isSaveCommit = addedFiles.length > 0;
		var nonEmpty = isSaveCommit; // Always commit if we add files
		for (const filepath of addedFiles) {
			await index.addByPath(filepath);
		}
		for (const filepath of deletedFiles) {
			// Don't try to remove (and commit) non-versioned files since it would create empty commits
			nonEmpty |= await index.find(filepath).then(async function() {
				// Even though we just found the path we can't use the index to remove it?
				// So we remove it by looking it up by path again
				// (Also removeByPath() doesn't return an error if the path doesn't exist in the index so we can't use it instead of find() above.)
				await index.removeByPath(filepath);
				return true;
			}).catch(function() {
				return false;
			});
		}
		if (nonEmpty) {
			// Write the index and commit
			await index.write();
			var oid = await index.writeTree();
			var head = await gitState.repo.getHeadCommit();
			// If saving the story list or a draft tiddler several times in a row, squash with the previous commit instead of creating a separate one
			var amend = isSaveCommit && (tiddlerTitle == gitState.lastSaved) && ((tiddlerTitle == '$:/StoryList') || isDraft);
			if (amend) {
				await head.amend('HEAD', gitState.config.sig, gitState.config.sig, null, message, oid);
			} else {
				await gitState.repo.createCommit('HEAD', gitState.config.sig, gitState.config.sig, message, oid, [head]);
			}
			// Remember the tiddler we just saved, for commit squashing
			gitState.lastSaved = isSaveCommit ? tiddlerTitle : null;
			// Re-schedule push on timeout
			gitState.doPush = true;
			if (gitState.config.remote.pushTimeout > 0) {
				clearTimeout(gitState.pushTimeoutTimer);
				gitState.pushTimeoutTimer = setTimeout(gitPushRepo, gitState.config.remote.pushTimeout*1000);
			}
		}
	}).catch(function(reason) {
		$tw.syncer.logger.log("Git commit failed: "+reason);
	});
}

function gitPushRepo() {
	gitState.op = gitState.op.then(async function() {
		if (!gitState.doPush)
			return;
		var options = {
			callbacks: {
				credentials: function(url, userName) {
					if (gitState.config.remote.agentAuth) {
						return git.Cred.sshKeyFromAgent(userName);
					} else if (gitState.config.remote.pubkeyAuth) {
						var [pubkey, privkey] = gitState.config.remote.pubkeyAuth;
						return git.Cred.sshKeyNew(userName, pubkey, privkey);
					}
				}
			}
		};
		var branch = await gitState.repo.getCurrentBranch();
		var remote = await gitState.repo.getRemote(gitState.config.remote.name);
		await remote.push([branch.name() + ':' + branch.name()], options);
		gitState.lastSaved = null; // We just pushed, don't squash next commit
		$tw.syncer.logger.log("Git repository pushed.");
		gitState.doPush = false;
	}).catch(function(reason) {
		$tw.syncer.logger.log("Git push failed:", reason);
	});
}

function FileSystemAdaptor(options) {
	var self = this;
	this.wiki = options.wiki;
	this.boot = options.boot || $tw.boot;
	this.logger = new $tw.utils.Logger("filesystem",{colour: "blue"});
	// Create the <wiki>/tiddlers folder if it doesn't exist
	$tw.utils.createDirectory(this.boot.wikiTiddlersPath);
}

FileSystemAdaptor.prototype.name = "filesystem";

FileSystemAdaptor.prototype.supportsLazyLoading = false;

FileSystemAdaptor.prototype.isReady = function() {
	// The file system adaptor is always ready
	return true;
};

FileSystemAdaptor.prototype.getTiddlerInfo = function(tiddler) {
	//Returns the existing fileInfo for the tiddler. To regenerate, call getTiddlerFileInfo().
	var title = tiddler.fields.title;
	return this.boot.files[title];
};

/*
Return a fileInfo object for a tiddler, creating it if necessary:
  filepath: the absolute path to the file containing the tiddler
  type: the type of the tiddler file (NOT the type of the tiddler -- see below)
  hasMetaFile: true if the file also has a companion .meta file

The boot process populates this.boot.files for each of the tiddler files that it loads.
The type is found by looking up the extension in $tw.config.fileExtensionInfo (eg "application/x-tiddler" for ".tid" files).

It is the responsibility of the filesystem adaptor to update this.boot.files for new files that are created.
*/
FileSystemAdaptor.prototype.getTiddlerFileInfo = function(tiddler,callback) {
	// Always generate a fileInfo object when this fuction is called
	var title = tiddler.fields.title, newInfo, pathFilters, extFilters;
	if(this.wiki.tiddlerExists("$:/config/FileSystemPaths")) {
		pathFilters = this.wiki.getTiddlerText("$:/config/FileSystemPaths","").split("\n");
	}
	if(this.wiki.tiddlerExists("$:/config/FileSystemExtensions")) {
		extFilters = this.wiki.getTiddlerText("$:/config/FileSystemExtensions","").split("\n");
	}
	newInfo = $tw.utils.generateTiddlerFileInfo(tiddler,{
		directory: this.boot.wikiTiddlersPath,
		pathFilters: pathFilters,
		extFilters: extFilters,
		wiki: this.wiki,
		fileInfo: this.boot.files[title],
		originalpath: this.wiki.extractTiddlerDataItem("$:/config/OriginalTiddlerPaths",title,"")
	});
	callback(null,newInfo);
};


/*
Save a tiddler and invoke the callback with (err,adaptorInfo,revision)
*/
FileSystemAdaptor.prototype.saveTiddler = function(tiddler,callback,options) {
	var self = this;
	var syncerInfo = options.tiddlerInfo || {};
	this.getTiddlerFileInfo(tiddler,function(err,fileInfo) {
		if(err) {
			return callback(err);
		}
		$tw.utils.saveTiddlerToFile(tiddler,fileInfo,function(err,fileInfo,savedFiles) {
			if(err) {
				if ((err.code == "EPERM" || err.code == "EACCES") && err.syscall == "open") {
					fileInfo = fileInfo || self.boot.files[tiddler.fields.title];
					fileInfo.writeError = true;
					self.boot.files[tiddler.fields.title] = fileInfo;
					$tw.syncer.logger.log("Sync failed for \""+tiddler.fields.title+"\" and will be retried with encoded filepath",encodeURIComponent(fileInfo.filepath));
					return callback(err);
				} else {
					return callback(err);
				}
			}
			// Store new boot info only after successful writes
			self.boot.files[tiddler.fields.title] = fileInfo;
			// Cleanup duplicates if the file moved or changed extensions
			var options = {
				adaptorInfo: syncerInfo.adaptorInfo || {},
				bootInfo: fileInfo || {},
				title: tiddler.fields.title
			};
			$tw.utils.cleanupTiddlerFiles(options,function(err,fileInfo,deletedFiles) {
				if(git) {
					// Commit changes even if there was an error
					var message = "Save tiddler \""+tiddler.fields.title+"\"";
					gitCommitChanges(tiddler.fields.title, savedFiles, deletedFiles, message, tiddler.isDraft());
				}
				if(err) {
					return callback(err);
				}
				return callback(null,fileInfo);
			});
		});
	});
};

/*
Load a tiddler and invoke the callback with (err,tiddlerFields)

We don't need to implement loading for the file system adaptor, because all the tiddler files will have been loaded during the boot process.
*/
FileSystemAdaptor.prototype.loadTiddler = function(title,callback) {
	callback(null,null);
};

/*
Delete a tiddler and invoke the callback with (err)
*/
FileSystemAdaptor.prototype.deleteTiddler = function(title,callback,options) {
	var self = this,
		fileInfo = this.boot.files[title];
	// Only delete the tiddler if we have writable information for the file
	if(fileInfo) {
		$tw.utils.deleteTiddlerFile(fileInfo,function(err,fileInfo,deletedFiles) {
			if(git) {
				// Commit changes even if there was an error
				// (We can't tell if it was a draft tiddler or not, since the tiddler object has been deleted already. It's not a problem though, since we won't commit the deletion of a file if it wasn't versioned in the first place.)
				var message = "Delete tiddler \""+title+"\"";
				gitCommitChanges(title, [], deletedFiles, message, false);
			}
			if(err) {
				if ((err.code == "EPERM" || err.code == "EACCES") && err.syscall == "unlink") {
					// Error deleting the file on disk, should fail gracefully
					$tw.syncer.displayError("Server desynchronized. Error deleting file for deleted tiddler \"" + title + "\"",err);
					return callback(null,fileInfo);
				} else {
					return callback(err);
				}
			}
			// Remove the tiddler from self.boot.files & return null adaptorInfo
			delete self.boot.files[title];
			return callback(null,null);
		});
	} else {
		callback(null,null);
	}
};

if(fs) {
	exports.adaptorClass = FileSystemAdaptor;
}

})();
