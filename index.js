require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

var DiscordStrategy = require('passport-discord').Strategy;
var passport = require('passport');
var session = require('express-session');

var scopes = ['identify'];

var db = {
    get: function () {
        return JSON.parse(fs.readFileSync('db.json'));
    },
    setKey: function (key, value) {
        var data = this.get();
        data[key] = value;
        fs.writeFileSync('db.json', JSON.stringify(data, null, 2));
    },
    getKey: function (key) {
        return this.get()[key];
    },
    set: function (data) {
        fs.writeFileSync('db.json', JSON.stringify(data, null, 2));
    }
}

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'http://localhost:3000/auth/discord/callback',
    scope: scopes
},
    function (accessToken, refreshToken, profile, done) {
        process.nextTick(function () {
            return done(null, profile);
        });
    }
));
passport.serializeUser(function (user, done) {
    done(null, user);
});
passport.deserializeUser(function (obj, done) {
    done(null, obj);
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use('/cdn', express.static(path.join(__dirname, 'uploads')));
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: 'super-super-secret:)',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    }
);

app.get('/', (req, res) => {
    if (!req.isAuthenticated()) return res.render("index");
    var files = []
    var filter = req.query.filter;
    if (filter) {
        files = db.getKey(req.user.id).files;
    } else {
        var data = db.get();
        for (var key in data) {
            data[key].files.map(f => f.owner = key);
            files.push(...data[key].files);
        }
    }

    res.render("main", { files: files, sorted: (a,b) => new Date(parseInt(b.filename.split("-")[0])) - new Date(parseInt(a.filename.split("-")[0])), user: req.user });

});

app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }
    if (db.getKey(req.user.id) === undefined) {
        db.setKey(req.user.id, { files: [] });
    }
    var data = db.getKey(req.user.id);
    data.files.push(req.file);
    db.setKey(req.user.id, data);
    res.json({ success: true });
    req.file.owner = req.user.id;
    io.emit('newImage', req.file);
});


app.post('/edit', upload.single('croppedImage'), (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    const user = db.getKey(req.user.id);
    if (!user.files.find(f => f.filename === req.body.filename)) {
        return res.status(403).json({ success: false, error: 'You do not have permission to edit this file.' });
    }

    const { filename } = req.body;
    const oldFile = db.getKey(req.user.id).files.find(f => f.filename === filename);
    if (!oldFile) {
        return res.status(404).json({ success: false, error: 'File not found.' });
    }

    const oldFilePath = path.join(__dirname, 'uploads', oldFile.filename);
    fs.unlink(oldFilePath, (err) => {
        if (err) {
            console.error('Error deleting old file:', err);
            return res.status(500).json({ success: false, error: 'Error deleting old file.' });
        }
        console.log(req.file)
        const newFile = {
            ...req.file,
            oldFilename: filename,
            owner: req.user.id
        };

        const userData = db.getKey(req.user.id);
        userData.files = userData.files.map(f => (f.filename === filename ? newFile : f));
        db.setKey(req.user.id, userData);

        res.json({ success: true });
        console.log(newFile)
        io.emit('editImage', newFile);
    });
});

app.delete('/delete/:file', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const { file } = req.params;
    const userData = db.getKey(req.user.id);
    const fileIndex = userData.files.findIndex(f => f.filename === file);
    if (fileIndex === -1) {
        return res.status(404).json({ success: false, error: 'File not found.' });
    }

    const filePath = path.join(__dirname, 'uploads', file);
    fs.unlink(filePath, (err) => {
        if (err) {
            console.error('Error deleting file:', err);
            return res.status(500).json({ success: false, error: 'Error deleting file.' });
        }

        userData.files.splice(fileIndex, 1);
        db.setKey(req.user.id, userData);
        res.json({ success: true });
        io.emit('deleteImage', file);
    });
});


app.get('/download/:file', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    var file = db.getKey(req.user.id).files.find(f => f.filename === req.params.file);
    if (!file) return res.status(404).render("error", { error: "Not Found", code: "404", errormessage: "The requested file was not found on this server.", textcolor: "primary", color: "#007bff" });
    res.download(`uploads/${file.filename}`);
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render("error", { error: "Internal Server Error", code: "500", errormessage: "An internal server error occurred.", textcolor: "danger", color: "#dc3545" });
});


app.use((req, res) => {
    res.status(404).render("error", { error: "Not Found", code: "404", errormessage: "The requested URL was not found on this server.", textcolor: "warning", color: "#ffc107" });
});


io.on('connection', (socket) => {
    console.log('a user connected');
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

server.listen(3000, () => {
    console.log('listening on 3000');
});
