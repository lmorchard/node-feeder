function t_now () { return new Date(); }

$("img.lazy").lazyload({
    // threshold: 100,
    effect: "fadeIn"
});

$('section#poll').each(function () {
    
    var sock = io.connect('http://localhost:9070');
    
    sock.on('echo', function (data) {
        console.log("ECHO", data);
    });

    function status (msg) {
        $('#status-message').text(msg);
    }

    var t_start = null;
    var times;

    setInterval(function () {
        $('.inprogress li').each(function () {
            var el = $(this);
            var start = el.data('start');
            if (start) {
                var now = t_now();
                var t_delta = now - start;
                el.find('.time').text(t_delta);
            }
        });
    }, 100);

    sock.on('disconnect', function () {
            status('DISCONNECT!');
            sock = io.connect('http://localhost:9070');
        })
        .on('poll:allStart', function () {
            status('Poll started');
            t_start = t_now();
            times = {};
            $('.polls .inprogress').empty();
            $('.polls .finished').empty();
        })
        .on('poll:inProgress', function () {
            status('Poll already in progress');
        })
        .on('poll:notInProgress', function () {
            status('Poll not in progress');
        })
        .on('poll:start', function (msg) {
            var id = 'poll-' + md5(msg.url);
            
            var item = $([
                '<li>',
                '<span class="status badge">000</span>',
                '&nbsp;',
                '<span class="time badge badge-inverse">---</span>',
                '&nbsp;',
                '<span class="parsed badge">---</span>',
                '&nbsp;',
                '<span class="url"></span>',
                '</li>'
            ].join(''));

            item.attr('id', id)
                .data('start', t_now())
                .find('.url').text(msg.url).end()
                .prependTo('.inprogress');
        })
        .on('poll:parsed', function (msg) {
            var id = 'poll-' + md5(msg.url);
            var item = $('#' + id);
            item.find('.parsed').text(msg.new_items_ct + ' / ' + msg.parsed_ct);
        })
        .on('poll:end', function (msg) {
            var id = 'poll-' + md5(msg.url);
            var item = $('#' + id);

            item.prependTo('.finished');

            var t_start = item.data('start');
            item.find('.time').text(t_now() - t_start);
            
            var badge = item.find('.status');
            badge.text(msg.status_code);
            badge.removeClass('hidden');
            if (msg.status_code >= 500) {
                badge.addClass('badge-important');
            } else if (msg.status_code >= 400) {
                badge.addClass('badge-important');
            } else if (msg.status_code >= 300) {
                badge.addClass('badge-info');
            } else if (msg.status_code >= 200) {
                badge.addClass('badge-success');
            }
        })
        .on('poll:abort', function () {
            status('Poll aborted');
        })
        .on('poll:allEnd', function () {
            var t_delta = t_now() - t_start;
            status('Poll ended in ' + t_delta + 'ms');
        });

    $('#startPoll').click(function (ev) {
        sock.emit('startPoll', {
            max_age: 1000 * 60 * 30,
            concurrency: 8
        });
    });

    $('#abortPoll').click(function (ev) {
        sock.emit('abortPoll');
    });

});
