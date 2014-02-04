var _ = require('lodash'),
	crypto = require('crypto'),
	fs = require('fs'),
	hooks = require('hooks'),
	emails = require('emailjs'),
	helper = require('../lib/helpers').Helpers;

/**
 * Responsible for handling user related actions ie registering, logging in, forgot passwords etc
 *
 * @class	UserManager
 * @method 	UserManager
 * @extend	false
 * @return 	void
 */
function UserManager() {
	var self = this;

	application.ee.on('ready', function() {
		fibrous.run(self.init.bind(self));
	});
}
		
/**
 * Description
 *
 * @method 	init
 * @extend	true
 * @return 	void
 */
UserManager.prototype.init = function() {
	var self = this,
		smtp = application.config.email.smtp.split(/(^smtp\:\/\/|\:|\@)/);
		this.server = emails.server.connect({
			user: smtp[2], 
			password: smtp[4], 
			host: smtp[6], 
			ssl: true
		});
	// setup email server

	application.app.post('/api/register', function(req, res) {
		var response = self.registerUser(req, res);

		res.header('Content-Type', 'application/json');
		res.end(JSON.stringify(response));
	});

	application.app.post('/api/login', function(req, res) {
		var response = self.userLogin(req, res);

		res.header('Content-Type', 'application/json');
		res.end(JSON.stringify(response));
	});

	application.app.post('/api/forgot', function(req, res) {
		var response = self.forgotPassword(req, res);

		res.header('Content-Type', 'application/json');
		res.end(JSON.stringify(response));
	});

	application.app.post('/api/reset', function(req, res) {
		var response = self.resetPassword(req, res);

		res.header('Content-Type', 'application/json');
		res.end(JSON.stringify(response));
	});
	// setup routes
}

/**
 * Handles user registrations, it takes req and res objects from express at the moment
 * however it should probably stay this way, because the api to register a user is at /api/register
 * I can't see a reason to change this to take individual parameters.
 *
 * @method 	registerUser
 * @param 	{Object} req
 * @param 	{Object} res
 * @extend	true
 * @return 	{Object}
 */
UserManager.prototype.registerUser = function(req, res) {
	var name = req.param('name', ''),
		nickname = req.param('nickname', ''),
		email = req.param('email', ''),
		password = req.param('password', ''),
		confirmPassword = req.param('confirmPassword', ''),
		output = {failed: false, successMessage: '', errors: []};

	if (!application.config.enableRegistrations) {
		output.errors.push({error: 'New registrations are currently closed'});
	} else {
		name = helper.trimInput(name);
		nickname = helper.trimInput(nickname);
		email = helper.trimInput(email);

		if (name == '' || nickname == '' || email == '' || password == '' || confirmPassword == '')
			output.errors.push({error: 'All fields are required'});

		if (!helper.isValidName(name))
			output.errors.push({error: 'The name you have entered is too long'});
		if (!helper.isValidNickname(nickname))
			output.errors.push({error: 'The nickname you have entered is invalid'});
		if (!helper.isValidEmail(email))
			output.errors.push({error: 'The email address you have entered is invalid'});
		if (!helper.isValidPassword(password))
			output.errors.push({error: 'The password you have entered is invalid'});
		if (password != confirmPassword)
			output.errors.push({error: 'The passwords you have entered do not match'});
	}

	if (output.errors.length > 0) {
		output.failed = true;
		return output;
	}
	// any errors?

	var salt = helper.generateSalt(10),
		user = {
			email: email,
			password: crypto.createHmac('sha256', salt).update(password).digest('hex'),
			salt: salt,
			tokens: {},
			profile: {
				name: name,
				nickname: nickname
			}
		};
	// the user record

	var find = application.Users.sync.find({email: email}).sync.toArray();
	if (find.length > 0) {
		output.failed = true;
		output.errors.push({error: 'The email you have used is already in use'});

		return output;
	} else {
		application.Users.sync.insert(user);
	}
	// it's failed, lets bail

	application.logger.log('info', 'account created', helper.cleanObjectIds(_.cloneDeep(user)));
	// log this event

	var message = {
		text: this.parse('./private/emails/signup.txt', {name: name}),
		from: application.config.email.from,
		to: email,
		subject: 'Welcome to ' + application.config.email.siteName
	};
	
	this.server.send(message);
	// send a email

	networkManager.addNetwork(user, application.config.defaultNetwork);
	// create a network for them

	output.successMessage = 'Your account has been successfully created, you may now login';
	return output;
}

/**
 * Handles the login call to /api/login and sets an appropriate cookie if successful
 *
 * @method userLogin
 * @param 	{Object} req
 * @param 	{Object} res
 * @extend	true
 * @return 	{Object}
 */
UserManager.prototype.userLogin = function(req, res) {
	var email = req.param('email', ''),
		password = req.param('password', ''),
		token = helper.generateSalt(25),
		expire = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)),
		output = {failed: false, successMessage: '', errors: []},
		user = application.Users.sync.findOne({email: email});

	if (user === null) {
		output.failed = true;
		output.errors.push({error: 'User not found'});
		// invalid user
	} else {
		var salt = user.salt,
			hash = crypto.createHmac('sha256', salt).update(password).digest('hex');

		if (req.cookies.token && _.find(user.tokens, {key: req.cookies.token}) !== undefined) {
			output.successMessage = 'Login successful';
			// check for a token
		} else {
			if (hash != user.password) {
				output.failed = true;
				output.errors.push({error: 'Password incorrect'});
			} else {
				output.successMessage = 'Login successful';
				// set the output

				var tokens = user.tokens;
					tokens[token] = {
						time: expire,
						ip: req.ip
					};

				application.Users.sync.update({email: email}, {$set: {tokens: tokens}});
				res.cookie('token', token, {expires: expire});
				// set a login key and a cookie

				this.onUserLogin(user);
			}
			// check if password matches
		}
	}

	return output;
}

/**
 * Handles the call to /api/forgot to send a forgot password link
 * 
 * @method forgotPassword
 * @param 	{Object} req
 * @param 	{Object} res
 * @extend	true
 * @return 	{Object}
 */
UserManager.prototype.forgotPassword = function(req, res) {
	var output = {failed: false, successMessage: '', errors: []},
		email = req.param('email', ''),
		token = helper.generateSalt(25),
		expire = new Date(Date.now() + (24 * 60 * 60 * 1000)),
		user = application.Users.sync.findOne({email: email});

	if (user === null) {
		output.failed = true;
		output.errors.push({error: 'User not found'});
		// invalid user
	} else {
		var resetToken = {
			token: token,
			time: expire,
			ip: req.ip
		};

		application.Users.sync.update({email: email}, {$set: {resetToken: resetToken}});
		// set the reset token

		var link = application.config.url + '/reset/' + token,
			message = {
				text: this.parse('./private/emails/reset.txt', {name: user.name, link: link}),
				from: application.config.email.from,
				to: email,
				subject: 'Your new password'
			};
		
		this.server.send(message);
		// send a email

		output.successMessage = 'Instructions on how to reset your password have been sent';
	}

	return output;
}

/**
 * Handles the call to /api/reset which will be called when the reset password link is visited
 * Checking is done to make sure a token exists in a user record.
 * 
 * @method resetPassword
 * @param 	{Object} req
 * @param 	{Object} res
 * @extend	true
 * @return 	{Object}
 */
UserManager.prototype.resetPassword = function(req, res) {
	var output = {failed: false, successMessage: '', errors: []},
		password = req.param('password', ''),
		confirmPassword = req.param('confirmPassword', ''),
		token = req.param('token', ''),
		time = new Date(Date.now()),
		user = application.Users.sync.findOne({'resetToken.token': token, 'resetToken.time': {$lte: new Date(Date.now() + (24 * 60 * 60 * 1000))}});

	if (user === null) {
		output.failed = true;
		output.errors.push({error: 'Invalid reset password url'});
	} else if (password == '' || confirmPassword == '') {
		output.failed = true;
		output.errors.push({error: 'All fields are required'});
	} else if (!helper.isValidPassword(password) || !helper.isValidPassword(confirmPassword)) {
		output.failed = true;
		output.errors.push({error: 'The password you have entered is invalid'});
	} else if (password != confirmPassword) {
		output.failed = true;
		output.errors.push({error: 'The passwords you have entered do not match'});
	} else {
		var salt = user.salt,
			hash = crypto.createHmac('sha256', salt).update(password).digest('hex');

		application.Users.sync.update({'resetToken.token': token}, {$unset: {resetToken: 1}, $set: {password: hash}});
		// set the password

		output.successMessage = 'Your password has been reset, you may now login';
	}

	return output;
}

/**
 * An event which is called when a successful login occurs, this logic is kept out of
 * the handler for /api/login because it's specific to a different section of the application
 * which is the networkManager and ircFactory.
 * 
 * @method 	onUserLogin
 * @param 	{Object} me
 * @extend	true
 * @return 	void
 */
UserManager.prototype.onUserLogin = function(me) {
	var userId = me._id; 

	if (me == null) {
		return;
	}

	var networks = application.Networks.sync.find({'internal.userId': userId}).sync.toArray();
	// find user's networks (use fetch cause we're going to manually push to it if no networks exist)

	for (var netId in networks) {
		var network = networks[netId],
			reconnect = false;

		if (network.internal.status !== networkManager.flags.disconnected) {
			reconnect = true;
		}

		if (reconnect) {
			networkManager.connectNetwork(network);
		}
	}
	// loop through our networks and connect them if need be

	application.logger.log('info', 'user logged in', {userId: userId.toString()});
	// log this event
}

/**
 * Looks for a template and parses the {{tags}} into the values in replace
 * and returns a string, used to parse emails.
 *
 * @method parse
 * @param 	{String} file
 * @param 	{Object} replace
 * @extend 	true
 * @return	{String}
 */
UserManager.prototype.parse = function(file, replace) {
	var template = fs.readFileSync(file).toString();

	for (var key in replace) {
		template.replace('{{' + key + '}}', replace[key]);
	}

	return template;
}

exports.UserManager = _.extend(UserManager, hooks);