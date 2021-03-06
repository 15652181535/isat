/*global document, window, console, setInterval, Cesium, Image, navigator, twoline2rv, sgp4, tle, gstime*/
(function () {
    'use strict';
    var ellipsoid       = Cesium.Ellipsoid.WGS84;
    var clock           = new Cesium.Clock();
    var orbitTraces       = new Cesium.PolylineCollection(); // currently only one at a time
    var satrecs         = [];   // populated from onclick file load
    var satdesigs       = [];   // populated from onclick file load
    var satnames        = [];   // populated from onclick file load
    var satids          = [];   // populated from onclick file load
    var satPositions    = [];   // calculated by updateSatrecsPosVel()
    var WHICHCONST      = 84;   //
    var TYPERUN         = 'm';  // 'm'anual, 'c'atalog, 'v'erification
    var TYPEINPUT       = 'n';  // HACK: 'now'
    var PLAY            = true;
    var SAT_POSITIONS_MAX = 25; // Limit numer of positions displayed to save CPU
    var CALC_INTERVAL_MS  = 1000;

    // TOGGLE Play
    document.getElementById('play_button').onclick = function () {
        PLAY = true;
    };
    document.getElementById('pause_button').onclick = function () {
        PLAY = false;
    };



    function getSatrecsFromTLEFile(fileName) {
        var tles = tle.parseFile(fileName);
        var satnum, max, rets, satrec, startmfe, stopmfe, deltamin;

        // Reset the globals
        satrecs = [];
        satnames = [];
        satdesigs = [];
        satids = [];

        for (satnum = 0, max = tles.length; satnum < max; satnum += 1) {
            satnames[satnum] = tles[satnum][0].trim();        // Name: (ISS (ZARYA))
            satdesigs[satnum] = tles[satnum][1].slice(9, 17); // Intl Designator YYNNNPPP (98067A)
            satids[satnum]   = tles[satnum][2].split(' ')[1]; // NORAD ID (25544)
            rets = twoline2rv(WHICHCONST, tles[satnum][1], tles[satnum][2], TYPERUN, TYPEINPUT);
            satrec   = rets.shift();
            startmfe = rets.shift();
            stopmfe  = rets.shift();
            deltamin = rets.shift();
            satrecs.push(satrec); // Don't need to sgp4(satrec, 0.0) to initialize state vector
        }
        // Returns nothing, sets globals: satrecs, satnames, satids
    }

    function updateSatrecsPosVel(satrecs, julianDate) {
        var satrecsOut = [];
        var positions = [];
        var velocities = [];
        var satnum, max, jdSat, minutesSinceEpoch, rets, satrec, r, v;

        for (satnum = 0, max = satrecs.length; satnum < max; satnum += 1) {
            jdSat = new Cesium.JulianDate.fromTotalDays(satrecs[satnum].jdsatepoch);
            minutesSinceEpoch = jdSat.getMinutesDifference(julianDate);
            rets = sgp4(satrecs[satnum], minutesSinceEpoch);
            satrec = rets.shift();
            r = rets.shift();      // [1802,    3835,    5287] Km, not meters
            v = rets.shift();
            satrecsOut.push(satrec);
            positions.push(r);
            velocities.push(v);
        }
        // UPDATE GLOBAL SO OTHERS CAN USE IT (TODO: make this sane w.r.t. globals)
        satPositions = positions;
        return {'satrecs': satrecsOut,
                'positions': positions,
                'velocities': positions};
    }


    function fMod2p(x) {
        var i = 0;
        var ret_val = 0.0;
        var twopi = 2.0 * Math.PI;

        ret_val = x;
        i = parseInt(ret_val / twopi);
        ret_val -= i * twopi;

        if (ret_val < 0.0)
            ret_val += twopi;

        return ret_val;
    }

    function calcLatLonAlt(time, position, satellite) {
        var r = 0.0,
            e2 = 0.0,
            phi = 0.0,
            c = 0.0,
            f = 3.35281066474748E-3,
            twopi = 6.28318530717958623,
            pio2 = 1.57079632679489656,
            pi = 3.14159265358979323,
            xkmper = 6378.137,
            rad2degree = 57.295;

        satellite.theta = Math.atan2(position[1],position[0]);
        satellite.lonInRads = fMod2p(satellite.theta - gstime(time));
        r = Math.sqrt(Math.pow(position[0], 2) + Math.pow(position[1], 2));
        e2 = f * (2 - f);
        satellite.latInRads = Math.atan2(position[2], r);

        do {
            phi = satellite.latInRads;
            c = 1 / Math.sqrt(1 - e2 * Math.pow(Math.sin(phi), 2));
            satellite.latInRads = Math.atan2((position[2] + xkmper * c * e2 * Math.sin(phi)), r);

        } while (Math.abs(satellite.latInRads - phi) >= 1E-10);

        satellite.alt = r / Math.cos(satellite.latInRads) - xkmper * c;

        if (satellite.latInRads > pio2) {
            satellite.latInRads -= twopi;
        }

        if (satellite.lonInRads > pio2) {
            satellite.lonInRads = -twopi + satellite.lonInRads;
        }

        satellite.latInDegrees = satellite.latInRads * rad2degree;
        satellite.lonInDegrees = satellite.lonInRads * rad2degree;
    }

    function displayPositions(time, sats) {
        var positionTable = document.getElementById('positions');
        var tbody = positionTable.getElementsByTagName('tbody')[0];
        var satnum, max, pos0, vel0, vel0Carte, carte, carto, newRow, latLonAlt;

        if (typeof tbody !== 'undefined' && tbody !== null) {
            positionTable.removeChild(tbody);
        }
        tbody = document.createElement('tbody');
        positionTable.appendChild(tbody);
        for (satnum = 0, max = satrecs.length; satnum < max && satnum < SAT_POSITIONS_MAX; satnum += 1) {
            pos0 = sats.positions[satnum];                 // position of first satellite
            vel0 = sats.velocities[satnum];
            latLonAlt = calcLatLonAlt(time, satPositions[satnum], satrecs[satnum]);
            vel0Carte = new Cesium.Cartesian3(vel0[0], vel0[1], vel0[2]);
            carte = new Cesium.Cartesian3(pos0[0], pos0[1], pos0[2]);
            // BUG: carto giving bad valus like -1.06, 0.88, -6351321 or NaN; radians instead of degrees?
            carto = ellipsoid.cartesianToCartographic(carte); // BUG: Values are totally unrealistic, height=NaN
            newRow = tbody.insertRow(-1);
            newRow.insertCell(-1).appendChild(document.createTextNode(satnames[satnum]));
            newRow.insertCell(-1).appendChild(document.createTextNode(satids[satnum]));
            newRow.insertCell(-1).appendChild(document.createTextNode(vel0Carte.magnitude().toFixed(0)));
            newRow.insertCell(-1).appendChild(document.createTextNode(satrecs[satnum].latInDegrees.toFixed(3)));
            newRow.insertCell(-1).appendChild(document.createTextNode(satrecs[satnum].lonInDegrees.toFixed(3)));
            var heightkm = satrecs[satnum].alt;
            var heightm = heightkm * 0.621371;
            newRow.insertCell(-1).appendChild(document.createTextNode(heightkm.toFixed(3)));
            newRow.insertCell(-1).appendChild(document.createTextNode(heightm.toFixed(3)));
        }
    }

    function computeStats() {
        var currentTime = clock.tick();
        var now = new Cesium.JulianDate(); // TODO: we'll want to base on tick and time-speedup
        var time = now.getJulianDayNumber() + now.getJulianTimeFraction();

        if (PLAY) {
            document.getElementById('date').textContent = currentTime.toDate();
        }
        if (satrecs.length > 0 && PLAY) {
            var sats = updateSatrecsPosVel(satrecs, now); // TODO: sgp4 needs minutesSinceEpoch from timeclock
            satrecs = sats.satrecs;                       // propagate [GLOBAL]
            displayPositions(time, sats);
        }
    }

    getSatrecsFromTLEFile('/media/sot/tle/SMD.txt');
    document.getElementById('select_satellite_group').onchange = function () {
        orbitTraces.removeAll();
        getSatrecsFromTLEFile('/media/sot/tle/' + this.value + '.txt'); // TODO: security risk?
    };

    setInterval(computeStats, CALC_INTERVAL_MS);

}());
