/*
Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at

    http://aws.amazon.com/asl/

or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
*/
var faker = require('faker');
var moment = require('moment');

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 3000;

var Redis = require('ioredis');
var redis_address = process.env.REDIS_ADDRESS || 'redis://127.0.0.1:6379';

var redis = new Redis(redis_address);
var redis_subscribers = {};
var channel_history_max = 10;

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
add_redis_subscriber('messages');
add_redis_subscriber('member_add');
add_redis_subscriber('member_delete');
add_redis_subscriber('pair');

io.on('connection', function (socket) {
    var get_members = redis.hgetall('members').then(function (redis_members) {
        var members = {};
        //console.log(redis_members);
        for (var key in redis_members) {
            members[key] = JSON.parse(redis_members[key]);
        }
        // console.log('Get all');
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
            avatar: "//api.adorable.io/avatars/30/" + username + '.png',
            buttons: [{ "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false },
            { "socket_id": '', "valid": false }],
            master_id: '',
            master_button_index: 0,
            lastTime: 0
        };
        member.lastTime = moment.now();
        //console.log(members);

        if (!isEmptyObject(members)) {
            let leastUsedKey = '';
            let leastTime = 0;

            for (let key in members) {

                if (members[key].lastTime < leastTime || leastTime === 0) {
                    leastTime = members[key].lastTime;
                    leastUsedKey = key;
                }

            }
            // console.log(members);
            // console.log(leastTime);
            for (let button of members[leastUsedKey].buttons) {
                let count = 0;
                if (!button.valid) {
                    members[leastUsedKey].lastTime = moment.now();
                    // console.log(key);
                    // console.log(leastUsedKey);
                    // console.log(members);
                    button.valid = true;
                    button.socket_id = member.socket;
                    member.master_id = members[leastUsedKey].socket;
                    member.master_button_index = count;
                    //redis.publish('pair', JSON.stringify(members));
                    console.log(members[leastUsedKey]);
                    redis.hdel('members', leastUsedKey).then(function () {
                        redis.hset('members', leastUsedKey, JSON.stringify(members[leastUsedKey]));
                    });
                    break;
                }
                count++;
            }
            // console.log(leastUsedKey);
            // console.log(members[leastUsedKey].buttons[0].valid);
            // console.log(members[leastUsedKey].buttons[1].valid);
            // console.log(members[leastUsedKey].buttons[2].valid);
        }

        return redis.hset('members', socket.id, JSON.stringify(member)).then(function () {
            // console.log("first member");
            // console.log(member);
            return member;
        });
    });

    // get the highest ranking messages (most recent) up to channel_history_max size
    var get_messages = redis.zrange('messages', -1 * channel_history_max, -1).then(function (result) {
        return result.map(function (x) {
            return JSON.parse(x);
        });
    });

    Promise.all([initialize_member, get_members, get_messages]).then(function (values) {
        var member = values[0];
        var members = values[1];
        var messages = values[2];
       
        io.emit('member_history', members);
        io.emit('message_history', messages);

        redis.publish('member_add', JSON.stringify(member));

        socket.on('send', function (message_text) {
            var date = moment.now();
            var message = JSON.stringify({
                date: date,
                username: member['username'],
                avatar: member['avatar'],
                message: message_text
            });

            redis.zadd('messages', date, message);
            redis.publish('messages', message);
        });

        socket.on('disconnect', function () {
           
            var get_master =
                redis.hget('members', socket.id).then(function (slave) {
                    //console.log(slave);
                    var parze_slave = JSON.parse(slave);
                   return redis.hget('members', parze_slave.master_id).then(function (master) {
                        console.log("get");
                        return JSON.parse(master);
                    });
                   
                });
               var update_master = get_master.then(function(master){
                    for(let button of master.buttons)
                    {
                        if(button.socket_id==socket.id) button.valid = false;
                    }
                    return redis.hdel('members', master.socket).then(function () {
                        return redis.hset('members', master.socket, JSON.stringify(master)).then(function(){
                            return master;
                        });
                        
                    });
                });
                Promise.all([get_master, update_master]).then(function (values)
                {
                    console.log("finish");
                    console.log(values[1]);
                    redis.hdel('members', socket.id);
                });
               
            redis.publish('member_delete', JSON.stringify(socket.id));
        });
    }).catch(function (reason) {
        console.log('ERROR: ' + reason);
    });
});

http.listen(port, function () {
    console.log('Started server on port ' + port);
});
