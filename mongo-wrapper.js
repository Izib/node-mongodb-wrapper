var mongodb = require("mongodb"),
    localcache = {},
    connections = {},
    allconnections = [],
    debug = process.env.debug || false;

/**
 * Database configurations, this way your api calls are more simple
 * like:  db.get("local", "mystuff", ....
 */
var databases = {
    test: {
        address: "127.0.0.1",
        port: 27017,
        name: "test"
    },
    local2: {
        address: "127.0.0.1",
        port: 27017,
        name: "local2"
    }
};

/**
 * Helper functions
 */
function trace(message) {

    if(!debug) {
        return;
    }

    console.log(Date() + "mongowrapper: ");
    console.log(message);
}

/**
 * Terminates a connection.
 * @param connection The collection name
 * @param db The database client
 */
function killConnection(cnn, error) {

    // disposed of after we terminated it
    if(!cnn.connection || !cnn.db) {
        cnn = null;
        return;
    }

    cnn.connection.close();
    cnn.connection = null;
    cnn = null;
    return;
}

/**
 * Nice and simple persistant connections.  If your application runs on
 * a PaaS or multiple instances each worker/whatever will have its own
 * connection pool.
 *
 * @param databasename Database configuration name
 * @param collectionname The collection name
 * @param operation The api operation
 * @param callback The callback function
 */
function getConnection(databasename, collectionname, operation, callback) {
    trace("fuction: getConnection");
    trace(databasename + ":" + collectionname);
    var database = databases[databasename];
    var options = {
        slave_ok: true
    };

    var db = new mongodb.Db(database.name, new mongodb.Server(database.address, database.port, options),{safe: true});
    db.open(function (error, connection) {

        var cnn = {
			connection: connection, 
			db: db,
			databasename: databasename
		};

        if(error) {
            trace("connection failed to " + databasename + ": "+ error);
            getConnection(databasename, collectionname, operation, callback);
            killConnection(cnn, error);
            return;
        }

        if(!database.username && !database.password) {

            callback(null, collectionname ? new mongodb.Collection(connection, collectionname) : null, cnn);
            return;
        }

        connection.authenticate(database.username, database.password, function(error) {

            if(error) {
                trace("unable to authenticate to " + database.name + " with " + database.username + " / " + database.password);
                getConnection(databasename, collectionname, operation, callback);
                killConnection(cnn, error);
                return;
            }

            callback(null, collectionname ? new mongodb.Collection(connection, collectionname) : null, cnn);
        });
    });
}

module.exports = db = {

    /**
     * Configuration settings
     * cacheEnabled stores data from get, getAndCount and queries
     * defaultCacheTime seconds to store cache data
     */
    cacheEnabled: true,
    defaultCacheTime: 60,

    /**
     * Import your own database collection
     *
     * @param dblist Your databases:  { db1: { address: "", port: , name: "db1" }, ... }
     */
    setDatabases:function(dblist) {
        trace("function: setDatabases");
        trace(dblist);
        databases = dblist;
        configureDatabases();
    },

    /**
     * Inserts an object into a collection.
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { doc: {}, safe: false }. In 2.6.6, "safe" is replaced by { writeConcern: { w: "majority", wtimeout: 5000 }}
     * @param callback Your callback method(error, item)
     */
    insert: function(database, collectionname, options, callback) {
        trace("fuction: insert");
        trace(collectionname);
        trace(options);		
        getConnection(database, collectionname, "insert", function(error, collection, cnn) {

            collection.insert(options.doc, {writeConcern: options.safe || { w: "majority", wtimeout: 5000 }}, function(error, items) {

                killConnection(cnn, error);

                if(error) {

                    trace("insert error: " + error);
                    if(callback) {
                        callback(error);
                    }

                    return;
                }

                if(callback) {
                    callback(null, items.length > 0 ? items[0] : {});
                }

                killConnection(cnn);
            });
        });
    },

    /**
     * Updates / Upserts an object into a collection.
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {}, doc: {}, safe: false, upsert: true } In 2.6.6, "safe" is replaced by { writeConcern: { w: "majority", wtimeout: 5000 }}
     * @param callback Your callback method(error, success)
     */
    update: function(database, collectionname, options, callback) {
        trace("fuction: update");
        trace(collectionname);
        trace(options);
        getConnection(database, collectionname, "update", function(error, collection, cnn) {

            collection.update(options.filter, options.doc, {writeConcern: options.safe || { w: "majority", wtimeout: 5000 }, upsert: options.upsert || true}, function(error) {

                killConnection(cnn, error);

                if(callback) {
                    callback(error, error == null);
                }

                if(error) {
                    trace("update error: " + error);
                }
            });
        });
    },

    /**
     * Selects one or more items
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {}, limit: 0, skip: 0, sort: {}, cache: false, cachetime: 60 }
     * @param callback Your callback method(error, items)
     */
    get: function(database, collectionname, options, callback) {

        if(options.cache) {
            var cached = cache.get(database, collectionname, "get", options);

            if(cached) {
                callback(null, cached);
                return;
            }
        }

        getConnection(database, collectionname, "get", function(error, collection, cnn) {

            collection.find(options.filter || {}).limit(options.limit || 0).skip(options.skip || 0).sort(options.sort || {}).toArray(function (error, items) {

                killConnection(cnn, error);

                if(error) {
                    trace("get error: " + error);
                } else if(options.cache) {
                    cache.set(database, collectionname, "get", options, items);
                }

                if(callback) {
                    callback(error, items || []);
                }
            });

        });
    },

    /**
     * Selects a single item or inserts it
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {}, doc: {}, safe: true or false }, In 2.6.6, "safe" is replaced by { writeConcern: { w: "majority", wtimeout: 5000 }}
     * @param callback Your callback method(error, item)
     */
    getOrInsert: function(database, collectionname, options, callback) {
        trace("fuction: getOrInsert");
        trace(collectionname);
        trace(options);
        getConnection(database, collectionname, "getOrInsert", function(error, collection, cnn) {

            collection.find(options.filter).limit(1).toArray(function (error, items) {

                if (error) {

                    killConnection(cnn, error);

                    if(callback) {
                        callback(error, []);
                    }

                    trace("getOrInsert error: " + error);
                    return;
                }

                // get it
                if(items.length > 0) {
                    killConnection(cnn, error);
                    callback(null, items[0]);
                    return;
                }

                // insert it
                collection.insert(options.doc, {writeConcern: options.safe || { w: "majority", wtimeout: 5000 }}, function(error, item) {

                    killConnection(cnn, error);

                    if(error) {

                        if(callback) {
                            callback(error, null);
                        }

                        trace("getOrInsert error2: " + error);
                        return;
                    }

                    if(callback) {
                        callback(null, item[0]);
                    }
                });
            });
        });
    },

    /**
     * Selects a subset of items and returns the total number
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {}, limit: 0, skip: 0, sort: {}, cache: false, cachetime: 60 }
     * @param callback Your callback method(error, items, numitems)
     */
    getAndCount: function(database, collectionname, options, callback) {

        if(options.cache) {
            var cached = cache.get(database, collectionname, "getAndCount", options);

            if(cached) {
                callback(null, cached.items, cached.numitems);
                return;
            }
        }

        getConnection(database, collectionname, "getAndCount", function(error, collection, cnn) {

            if(error) {

                if(callback) {
                    callback(error, [], 0);
                }

                trace("getAndCount error: " + error);
                killConnection(cnn, error);
                return;
            }

            collection.find(options.filter || {}).limit(options.limit || 0).skip(options.skip || 0).sort(options.sort || {}).toArray(function (error, items) {

                if (error) {

                    if(callback) {
                        callback(error, [], 0);
                    }

                    trace("getAndCount error: " + error);
                    killConnection(cnn, error);
                    return;
                }

                // note we could use the api here but it would potentially
                // establish a second connection and change the cache key
                collection.count(options.filter, function(error, numitems) {

                    killConnection(cnn, error);

                    if (error) {

                        if(callback) {
                            callback(error, [], 0);
                        }

                        trace("getAndCount error: " + error);
                        return;
                    }

                    if(options.cache) {
                        cache.set(database, collectionname, "getAndCount", options, {items: items, numitems: numitems});
                    }

                    if(callback) {
                        callback(null, items, numitems);
                    }
                });
            });
        });
    },
	
    /**
     * Aggregates a collection
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { aggregate: [pipeline], cache: false, cachetime: 60 }
     * @param callback Your callback method(error, items, numitems)
     */
    aggregate: function(database, collectionname, options, callback) {

        if(options.cache) {
            var cached = cache.get(database, collectionname, "aggregate", options);

            if(cached) {
                callback(null, cached.items);
                return;
            }
        }

        getConnection(database, collectionname, "aggregate", function(error, collection, cnn) {

            if(error) {

                if(callback) {
                    callback(error, []);
                }

                trace("aggregate error: " + error);
                killConnection(cnn, error);
                return;
            }

            collection.aggregate(options.aggregate).toArray(function (error, items) {

                if (error) {

                    if(callback) {
                        callback(error, []);
                    }

                    trace("aggregate error: " + error);
                    killConnection(cnn, error);
                    return;
                }

                if(callback) {
                    callback(null, items);
                }
            });
        });
    },
	
    /**
     * Aggregates and counts the total number of aggregated reuslts
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { aggregate: [pipeline], count: [pipeline], cache: false, cachetime: 60 }
     * @param callback Your callback method(error, items, numitems)
     */
    aggregateAndCount: function(database, collectionname, options, callback) {

        if(options.cache) {
            var cached = cache.get(database, collectionname, "aggregateAndCount", options);

            if(cached) {
                callback(null, cached.items, cached.numitems);
                return;
            }
        }

        getConnection(database, collectionname, "aggregateAndCount", function(error, collection, cnn) {

            if(error) {

                if(callback) {
                    callback(error, [], 0);
                }

                trace("aggregateAndCount error: " + error);
                killConnection(cnn, error);
                return;
            }

            collection.aggregate(options.aggregate, function (error, items) {

                if (error) {
					
					console.log("aggregate failed");
					console.log(JSON.stringify(options, null, "\t"));
					console.log("error: " + error);

                    if(callback) {
                        callback(error, [], 0);
                    }

                    trace("aggregateAndCount error: " + error);
                    killConnection(cnn, error);
                    return;
                }

                collection.aggregate(options.count, function(error, numitems) {

                    killConnection(cnn, error);

                    if (error) {

                        if(callback) {
                            callback(error, [], 0);
                        }

                        trace("aggregateAndCount error: " + error);
                        return;
                    }
					
					numitems = numitems[0].count;

                    if(options.cache) {
                        cache.set(database, collectionname, "aggregateAndCount", options, {items: items, numitems: numitems});
                    }
					
                    if(callback) {
                        callback(null, items, numitems);
                    }
                });
            });
        });
    },

    /**
     * Counts the number of items matching a query
     *
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {}, cache: false, cachetime: 60 }
     * @param callback Your callback method(error, numitems)
     */
    count: function(database, collectionname, options, callback) {

        if(options.cache) {
            var cached = cache.get(database, collectionname, "count", options);

            if(cached) {
                callback(null, cached);
                return;
            }
        }

        getConnection(database, collectionname, "count", function(error, collection, cnn) {

            collection.count(options.filter, function (error, numitems) {

                killConnection(cnn, error);

                if (error) {
                    if(callback) {
                        callback(error, []);
                    }

                    trace("count error: " + error);
                    return;
                }

                if(options.cache) {
                    cache.set(database, collectionname, "count", numitems);
                }

                if(callback) {
                    callback(null, numitems);
                }
            });
        });
    },

    /**
     * Moves a document from one collection to another
     * @param database Database config name
     * @param collection1name The source collection name
     * @param collection2name The destination collection name
     * @param options { doc: {... }, overwrite: true, safe: false, }, In 2.6.6, "safe" is replaced by { writeConcern: { w: "majority", wtimeout: 5000 }}
     * @param callback Your callback method(error, success)
     */
    move: function(database, collection1name, collection2name, options, callback) {

        getConnection(database, collection1name, "move", function(error, collection1, cnn1) {

            if(error) {

                if(callback) {
                    callback(error);
                }

                trace("move error: " + error);
                killConnection(cnn1, error);
                return;
            }

            getConnection(database, collection2name, "move", function(error, collection2, cnn2) {

                if(error) {

                    if(callback) {
                        callback(error);
                    }

                    trace("remove error: " + error);
                    killConnection(cnn1);
                    killConnection(cnn2, error);
                    return;
                }
				
				collection2.find(options.doc).toArray(function(error, items) {

					if(error) {
                        if(callback) {
                            callback(error);
                        }
						trace("move error: " + error);
                        killConnection(cnn1);
                        killConnection(cnn2, error);
						return;						
					}
					
					if(items && items.length) {
						
						var item = items[0];
					
						if(item && !options.overwrite && !options.upsert) {
							if(callback) {
								callback("Document exists in destination collection");
							}
						
							trace("move error: document exists in destination collection");
	                        killConnection(cnn1);
	                        killConnection(cnn2, error);
							return;
						}
					
						else if(item) {
							options.doc._id = item._id;
						}
					} else {
					
						collection2.insert(options.doc, function(error) {
		                    
							if(error) {
		                        trace("remove error: " + error);
		                        killConnection(cnn1);
		                        killConnection(cnn2, error);
		                    }

							callback(error);
							
						});
						
						return;
					}
						
	                collection2.update(options.doc, options.doc, {writeConcern: options.safe || { w: "majority", wtimeout: 5000 }, upsert: options.upsert || options.overwrite}, function(error) {

	                    if(error) {

	                        if(callback) {
	                            callback(error);
	                        }

	                        trace("remove error: " + error);
	                        killConnection(cnn1);
	                        killConnection(cnn2, error);
	                        return;
	                    }

	                    collection1.remove(options.doc, function(error) {

	                        killConnection(cnn1, error);
	                        killConnection(cnn2);

	                        if(error) {

	                            if(callback) {
	                                callback(error, false);
	                            }

	                            trace("remove error: " + error);
	                            return;
	                        }

	                        if(callback) {
	                            callback(null);
	                        }
	                    });
	                });
				});
            });
        })
    },

    /**
     * Removes one or more documents from a collection
     * @param database Database config name
     * @param collectionname The collection name
     * @param options { filter: {} }
     * @param callback Your callback method(error, success)
     */
    remove: function(database, collectionname, options, callback) {

        getConnection(database, collectionname, "remove", function(error, collection, cnn) {

            if(error) {

                if(callback) {
                    callback(error, false);
                }

                trace("remove error: " + error);
                killConnection(cnn, error);
                return;
            }

            collection.remove(options.filter, function(error) {

                killConnection(cnn, error);

                if(error) {
                    trace("remove error: " + error);
                }

                if(callback) {
                    callback(error, error == null);
                }
            });
        });
    }
};


/**
 * A very simple, self cleaning, local cache.  If your app runs on multiple threads
 * or a PaaS like Heroku each dyno / worker / whatever will have its own copy
 */
var cache = {

    get: function(databasename, collectionname, operation, options) {

        if(!db.cacheEnabled) {
            return null;
        }

        var database = databases[databasename];
        var key = database.name + ":" + database.collectionname + ":" + operation + ":" + JSON.stringify(options);
        return localcache[key] ? localcache[key].data : null;
    },

    set: function(databasename, collectionname, operation, options, obj) {

        if(!db.cacheEnabled) {
            return;
        }

        var database = databases[databasename];
        var key = database.name + ":" + database.collectionname + ":" + operation + ":" + JSON.stringify(options);
        localcache[key] = { data: obj, time: options.cachetime || db.defaultCacheTime};
    }
}

setInterval(function() {

    for(var key in localcache) {

        localcache[key].time--;

        if(localcache[key].time > 0) {
            continue;
        }

        localcache[key] = null;
        delete localcache[key];
    }

}, 1000);

/*
 * Creates the shorthand references to databases and provides methods
 * for including shorthand collection paths too.  You don't need to call
 * this manually, it will automatically apply to the locally defined
 * list of databases, or run again if you pass your own configuration.
 */
function configureDatabases() {
    for(var databasename in databases) {
		configureDatabase(databasename);
	}
}

configureDatabases();

function configureDatabase(databasename) {
	
	var alias = databasename;
	
	if(databases[databasename].alias) {
		alias = databases[databasename].alias;
	}
    
	db[alias] = databases[databasename];
	db[alias].databasename = databasename;

    /**
     * Initializes a collection's shorthand methods for accessing
	 * via db.databasename.collectionname.method(..)
     * @param collectionname the collection name
     */
    db[alias].collection = function(collectionname) {

        var databasename = this.databasename;
		
        db[databasename][collectionname] = {
			get: function(options, callback) { 
				db.get(databasename, collectionname, options, callback); 
			},
			getOrInsert: function(options, callback) { 
				db.getOrInsert(databasename, collectionname, options, callback); 
			},
			getAndCount: function(options, callback) { 
				db.getAndCount(databasename, collectionname, options, callback); 
			},
			count: function(options, callback) { 
				db.count(databasename, collectionname, options, callback); 
			},
			move: function(collection2name, options, callback) { 
				db.move(databasename, collectionname, collection2name, options, callback); 
			},
			update: function(options, callback) { 
				db.update(databasename, collectionname, options, callback); 
			},
			insert: function(options, callback) { 
				db.insert(databasename, collectionname, options, callback); 
			},
			remove: function(options, callback) { 
				db.remove(databasename, collectionname, options, callback); 
			},
			aggregate: function(options, callback) { 
				db.aggregate(databasename, collectionname, options, callback); 
			},
			aggregateAndCount: function(options, callback) { 
				db.aggregateAndCount(databasename, collectionname, options, callback); 
			}
		}
    };

    /**
     * Initializes the collection shorthand on a database
     * @param opt either an array of collection names or a callback method(error) for
     * loading directly from the db
     */
    db[alias].collections = function(opt) {

        var callback;
		var databasename = this.databasename;

		// received an array of collections
        if(opt) {

            if(typeof opt === 'function') {
                callback = opt;
            } else {
                for(var i=0; i<opt.length; i++) {
                    db[databasename].collection(opt[i]);
                }
                return;
            }
        }

		// look up the collections
        getConnection(databasename, "", "", function(error, collection, connection) {

            if(error) {
                callback(error);
                return;
            }
			
            connection.db.collectionNames({namesOnly: true}, function(error, names) {

                if(error) {
                    callback(error);
                    return;
                }

                for(var i=0; i<names.length; i++) {

                    var name = names[i];

                    if(name.indexOf(databasename + ".system.") == 0)
                        continue;

                    var collectionname = name.substring(databasename.length + 1);
                    db[databasename].collection(collectionname);
                }

                connection.db.close();
                connection = null;
                callback(null);
            });
        });
    }
}