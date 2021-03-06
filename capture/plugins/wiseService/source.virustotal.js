/******************************************************************************/
/*
 *
 * Copyright 2012-2016 AOL Inc. All rights reserved.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var request        = require('request')
  , wiseSource     = require('./wiseSource.js')
  , util           = require('util')
  ;

var source;

//////////////////////////////////////////////////////////////////////////////////
function VirusTotalSource (api, section) {
  VirusTotalSource.super_.call(this, api, section);
  this.waiting    = [];
  this.processing = {};

  this.key = this.api.getConfig("virustotal", "key");
  if (this.key === undefined) {
    console.log(this.section, "- No key defined");
    return;
  }

  this.dataSources = ["McAfee", "Symantec", "Microsoft", "Kaspersky"];
  this.dataSourcesLC = this.dataSources.map(function(x) {return x.toLowerCase();});
  this.dataFields = [];

  this.api.addSource("virustotal", this);
  setInterval(this.performQuery.bind(this), 500);

  var str = 
    "if (session.virustotal)\n" +
    "  div.sessionDetailMeta.bold VirusTotal\n" +
    "  dl.sessionDetailMeta\n";

  for(var i = 0; i < this.dataSources.length; i++) {
    var uc = this.dataSources[i];
    var lc = this.dataSourcesLC[i];
    this.dataFields[i] = this.api.addField("field:virustotal." + lc + ";db:virustotal." + lc + "-term;kind:lotermfield;friendly:" + uc + ";help:VirusTotal " + uc + " Status;count:true");
    str += "    +arrayList(session.virustotal, '" + lc + "-term', '" + uc + "', 'virustotal." + lc + "')\n";
  }

  this.hitsField = this.api.addField("field:virustotal.hits;db:virustotal.hits;kind:integer;friendly:Hits;help:VirusTotal Hits;count:true");
  this.linksField = this.api.addField("field:virustotal.links;db:virustotal.links-term;kind:termfield;friendly:Link;help:VirusTotal Link;count:true");


  str += "    +arrayList(session.virustotal, 'hits', 'Hits', 'virustotal.hits')\n";
  str += "    +arrayList(session.virustotal, 'links', 'Links', 'virustotal.links')\n";

  this.api.addView("virustotal", str);
}
util.inherits(VirusTotalSource, wiseSource);

//////////////////////////////////////////////////////////////////////////////////
VirusTotalSource.prototype.performQuery = function () {
  var self = this;

  if (self.waiting.length === 0) {
    return;
  }

  if (self.api.debug > 0) {
    console.log(self.section, "- Fetching %d", self.waiting.length);
  }

  var options = {
      url: 'https://www.virustotal.com/vtapi/v2/file/report?',
      qs: {apikey: self.key,
           resource: self.waiting.join(",")},
      method: 'GET',
      json: true
  };

  self.waiting.length = 0;


  var req = request(options, function(err, im, results) {
    if (err) {
      console.log(self.section, "Error parsing for request:\n", options, "\nresults:\n", results);
      results = [];
    } 
    if (!Array.isArray(results)) {
      results = [results];
    }

    results.forEach(function(result) {
      var cbs = self.processing[result];
      if (!cbs) {
        return;
      }
      delete self.processing[result];

      var wiseResult;
      if (result.response_code === 0) {
        wiseResult = wiseSource.emptyResult;
      }  else {
        var args = [self.hitsField, ""+result.positives, self.linksField, result.permalink];

        for(var i = 0; i < self.dataSources.length; i++) {
          var uc = self.dataSources[i];
          var lc = self.dataSourcesLC[i];

          if (result.scans[uc] && result.scans[uc].detected) {
            args.push(self.dataFields[i], result.scans[uc].result);
          }
        }

        wiseResult = {num: args.length/2, buffer: wiseSource.encode.apply(null, args)};
      }

      var cb;
      while ((cb = cbs.shift())) {
        cb(null, wiseResult);
      }
    });
  }).on('error', function (err) {
    console.log(self.section, err);
  });
};
//////////////////////////////////////////////////////////////////////////////////
VirusTotalSource.prototype.getMd5 = function(md5, cb) {
  var info = this.cache.get(md5);
  console.log(this.section, "Looking for", md5);

  if (md5 in this.processing) {
    this.processing[md5].push(cb);
    return;
  }

  this.processing[md5] = [cb];
  this.waiting.push(md5);
  if (this.waiting.length >= 25) {
    this.performQuery();
  }
};
//////////////////////////////////////////////////////////////////////////////////
var reportApi = function(req, res) {
  source.getMd5(req.query.resource, function(err, result) {
    //console.log(err, result);
    if(result.num === 0) {
      res.send({response_code: 0, resource: req.query.resource, verbose_msg: "The requested resource is not among the finished, queued or pending scans"});
    } else {
      var obj = {scans:{}};
      var offset = 0;
      for (var i = 0; i < result.num; i++) {
        var pos   = result.buffer[offset];
        var len   = result.buffer[offset+1];
        var value = result.buffer.toString('utf8', offset+2, offset+2+len-1);
        offset += 2 + len;
        switch (pos) {
        case source.hitsField:
          obj.positives = +value;
          break;
        case source.linksField:
          obj.permalink = value;
          break;
        default:
          for (var j = 0; j < source.dataFields.length; j++) {
            if (source.dataFields[j] === pos) {
              obj.scans[source.dataSources[j]] = {detected: true, result: value};
              break;
            }
          }
        }
      }
      res.send(obj);
    }
  });
};
//////////////////////////////////////////////////////////////////////////////////
exports.initSource = function(api) {
  api.app.get("/vtapi/v2/file/report", reportApi);
  var source = new VirusTotalSource(api, "virustotal");
};
//////////////////////////////////////////////////////////////////////////////////
