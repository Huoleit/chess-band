require('dotenv').config();
var faker = require('faker');
var moment = require('moment');

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 8008;

var Redis = require('ioredis');
var redis_address = process.env.REDIS_ADDRESS || 'redis://127.0.0.1:6379';

var redis = new Redis(redis_address);
var redis_subscribers = {};
var channel_history_max = 10;

var needToUpdate;
var updateFlag = false;
var update_new = false;
var new_user;
app.use(express.static('public'));
app.get('/health', function (request, response) {
    response.send('ok');
});

function isEmptyObject(obj) {
    return Object.keys(obj).length === 0;
}

function add_redis_subscriber(subscriber_key) {
    var client = new Redis(redis_address);

    client.subscribe(subscriber_key);
    client.on('message', function (channel, message) {
        io.emit(subscriber_key, JSON.parse(message));
    });

    redis_subscribers[subscriber_key] = client;
}
add_redis_subscriber('feel_sad');
add_redis_subscriber('member_add');
add_redis_subscriber('member_delete');
add_redis_subscriber('pair');
add_redis_subscriber('pair_termination');
add_redis_subscriber('give_comfort');

io.on('connection', function (socket) {
    var get_members = redis.hgetall('members').then(function (redis_members) {
        var members = {};
        for (let key in redis_members) {
            members[key] = JSON.parse(redis_members[key]);
        }
        return members;
    });

    var initialize_member = get_members.then(function (members) {
        if (members[socket.id]) {
            console.log("same connection");
            return members[socket.id];
        }

        var username = faker.fake("{{name.firstName}} {{name.lastName}}");
        var member = {
            socket: socket.id,
            username: username,
            // avatar: "//api.adorable.io/avatars/30/" + username + '.png',
            avatar: faker.image.avatar(),
            buttons: [
            { "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false }],
            master_id: '',
            lastTime: 0
        };
        member.lastTime = moment.now();

        if (!isEmptyObject(members)) {
            let leastUsedKey = '';
            let leastTime = 0;

            for (let key in members) {

                if (members[key].lastTime < leastTime || leastTime === 0) {
                    leastTime = members[key].lastTime;
                    leastUsedKey = key;
                }

            }

            for (let button of members[leastUsedKey].buttons) {
                if (!button.valid) {
                    members[leastUsedKey].lastTime = moment.now();
                    button.valid = true;
                    button.socket_id = member.socket;
                    member.master_id = members[leastUsedKey].socket;
                    member.buttons[0].socket_id = members[leastUsedKey].socket;
                    member.buttons[0].valid = true;
                    needToUpdate = members[leastUsedKey];
                    updateFlag = true;
                    update_new = true;
                    new_user = member;
                    
                    redis.hdel('members', leastUsedKey).then(function () {
                        redis.hset('members', leastUsedKey, JSON.stringify(members[leastUsedKey]));
                    });
                    break;
                }

            }

        }

        return redis.hset('members', socket.id, JSON.stringify(member)).then(function () {

            return member;
        });
    });

    // get the highest ranking messages (most recent) up to channel_history_max size
    var get_messages = redis.zrange('messages', -1 * channel_history_max, -1).then(function (result) {
        return result.map(function (x) {
            return JSON.parse(x);
        });
    });

    Promise.all([initialize_member, get_members]).then(function (values) {
        var member = values[0];
        var members = values[1];
        console.log(values[1]);
        //var messages = values[2];

        io.emit('member_history', members);
        //io.emit('message_history', messages);

        redis.publish('member_add', JSON.stringify(member));
        if (updateFlag) {
            redis.publish('pair', JSON.stringify(needToUpdate));
            updateFlag = false;
        }
        if(update_new)
        {
            redis.publish('pair', JSON.stringify(new_user));
            update_new = false;
        }

        socket.on('send_sadness', function (sadness) {
          
            console.log(sadness);
            redis.publish('feel_sad', JSON.stringify(sadness));
        });
        socket.on('send_comfort', function (comfort) {
          
            //console.log(sadness);
            redis.publish('give_comfort', JSON.stringify(comfort));
        });
        

        socket.on('disconnect', async function () {
            const slave = JSON.parse(await redis.hget('members', socket.id));
            if(slave){
                for (let button of slave.buttons) {
                    if (button.socket_id && button.valid) {
                        let master = JSON.parse(await redis.hget('members', button.socket_id));
                        for (let button_master of master.buttons) {
                            if (button_master.socket_id === socket.id) button_master.valid = false;
                        }
                        await redis.hdel('members', button.socket_id);
                        redis.hset('members', button.socket_id, JSON.stringify(master));
                        let delete_information = JSON.stringify({
                            master_id: button.socket_id,
                            slave_id: socket.id
                        });
                        redis.publish('pair_termination', delete_information);
                    }
    
                }

            }
            await redis.hdel('members', socket.id);
            redis.publish('member_delete', JSON.stringify(socket.id));
            

        });
    }).catch(function (reason) {
        console.log('ERROR: ' + reason);
    });
});

http.listen(port, function () {
    console.log('Started server on port ' + port);
});
