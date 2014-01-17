SocketManager = function() {
	"use strict";

	var _ = require('lodash'),
		hooks = require('hooks'),
		mongo = require('mongodb');

	var Manager = {
		allowedUpdates: {
			tabs: function(update) {
				return ((_.has(update, 'hiddenUsers') && typeof update.hiddenUsers === 'boolean') ||
						(_.has(update, 'hiddenEvents') && typeof update.hiddenUsers === 'boolean') || 
						(_.has(update, 'selected') && typeof update.hiddenUsers === 'boolean'));
			}
		},

		propogate: ['users', 'networks', 'tabs', 'events', 'channelUsers'],
		// collections with allowed update rules
		// very similar to Meteor - basically just reimplementing it, doesn't support advanced queries though

		init: function() {
			application.ee.on(['*', '*'], function(doc) {
				var collection = this.event[0];
				if (_.indexOf(Manager.propogate, collection) == -1) {
					return false;
				}

				if (collection === 'users') {
					var client = Users[doc._id.toString()];

					if (client) {
						client.emit('update', {collection: collection, record: doc});
					}
				} else if (collection === 'networks') {
					var client = Users[doc.internal.userId.toString()];

					if (client) {
						client.emit('update', {collection: collection, record: doc});
					}
				} else if (collection === 'tabs' || collection === 'events') {
					var client = Users[doc.user.toString()];

					if (client) {
						client.emit('update', {collection: collection, record: doc});
					}
				} else if (collection === 'channelUsers') {
					for (var id in Clients) {
						for (var tabId in Clients[id].internal.tabs) {
							var tab = Clients[id].internal.tabs[tabId];

							if (tab.networkName == doc.network && doc.channel == tab.target) {
								Users[tab.user.toString()].emit('update', {collection: collection, record: doc});
							}
						}
					}
				}
				// all of this code works by watching changes via the oplog, that way 
				// we dont need to worry about updating the database AND sending changes
				// to the frontend clients, we can just send the document down when we spot a change
				// to the clients who need to see it, a bit like meteor, without subscriptions
				// XXX - We can probably improve things by sending down only the fields
				//       that have changed and send only the changes to the client, and merge them
				//       client side - this means storing all the documents in memory though - or something like redis
			});

			application.app.io.set('authorization', function(data, accept) {
				fibrous.run(function() {
					accept(null, Manager.handleAuth(data));
				});
			});
			// socket authorisation

			application.app.io.on('connection', function (client) {
				fibrous.run(function() {
					client.on('disconnect', function() {
						Manager.handleDisconnect(client);
					});
					// handle disconnect

					Manager.handleConnect(client);
					// handle connect event
				});
			});

			application.app.io.route('events', function(req) {
				fibrous.run(function() {
					Manager.handleEvents(req);
				});
			});

			application.app.io.route('update', function(req) {
				fibrous.run(function() {
					var collection = req.data.collection,
						query = req.data.query,
						update = req.data.update;

					if (!collection || !query || !update) {
						return req.io.respond({success: false, error: 'invalid format'});
					}

					if (!_.isFunction(Manager.allowedUpdates[collection])) {
						return req.io.respond({success: false, error: 'cant update'});
					}

					if (!Manager.allowedUpdates[collection](update)) {
						return req.io.respond({success: false, error: 'not allowed'});
					}
					// have we been denied?

					if (query._id) {
						query._id = new mongo.ObjectId(query._id);
					}
					// update it to a proper mongo id

					application.mongo.collection(collection).sync.update(query, {$set: update});
					req.io.respond({success: true});
					// update and respond
				});
			});
		},

		handleAuth: function(data) {
			var parsed = (data.headers.cookie) ? data.headers.cookie.split('; ') : [],
				cookies = {};

			parsed.forEach(function(cookie) {
				var split = cookie.split('=');
					cookies[split[0]] = split[1];
			});
			// get our cookies

			if (!cookies.token) {
				return false;
			} else {
				var query = {};
					query['tokens.' + cookies.token] = {$exists: true};
				var user = application.Users.sync.findOne(query);

				if (user === null) {
					return false;
				} else {
					data.user = user;
				}
			}
			// validate the cookie

			return true;
			// accept the connection
		},

		handleConnect: function(client) {
			var user = client.handshake.user,
				networks = application.Networks.sync.find({'internal.userId': user._id}).sync.toArray(),
				tabs = application.Tabs.sync.find({user: user._id}).sync.toArray(),
				netIds = {};

			Sockets[client.id] = user;
			Users[user._id.toString()] = client; 
			// remember the link between the socket and the user

			networks.forEach(function(network) {
				netIds[network._id] = network.name;
			});

			tabs.forEach(function(tab) {
				tab.users = application.ChannelUsers.sync.find({network: netIds[tab.network], channel: tab.target}).sync.toArray()
			});
			// loop tabs

			client.emit('user', user);
			client.emit('networks', networks);
			client.emit('tabs', tabs);
			// compile a load of data to send to the frontend
		},

		handleDisconnect: function(client) {
			var user = Sockets[client.id];

			delete Users[user._id.toString()];
			delete Sockets[client.id];
			// clean up
		},

		handleEvents: function(req) {
			var response = application.Events.sync.find(req.data).sync.toArray();
			// perform the query

			req.io.respond(response);
			// get the data
		}
	};

	application.ee.on('ready', function() {
		fibrous.run(Manager.init);
	});

	return _.extend(Manager, hooks);
};

exports.SocketManager = SocketManager;