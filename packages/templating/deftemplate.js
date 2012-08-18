(function() {

  Meteor._partials = {};

  var landmarkOptionsHooks = [];
  Templating = {};

  // Extension point. When the top-level landmark for a template is
  // created, call f, which may return additional options to merge
  // into the landmark. The returned options can also include a
  // special pseudo-option, 'aroundHtml'. If provided, it's a function
  // that takes two arguments, landmark and next. The function is
  // called around rendering the template body and should return the
  // return value of next(). You can use this to do any necessary set
  // up for running helpers / teardown after running helpers.
  //
  // XXX note that this could be possibly be accomplished more
  // elegantly by just using the template's public interface to set up
  // preservations and callbacks
  Templating.optionsForTemplateLandmark = function (f) {
    landmarkOptionsHooks.push(f);
  };

  // XXX Handlebars hooking is janky and gross

  Meteor._hook_handlebars = function () {
    Meteor._hook_handlebars = function(){}; // install the hook only once

    var orig = Handlebars._default_helpers.each;
    Handlebars._default_helpers.each = function (arg, options) {
      // if arg isn't an observable (like LocalCollection.Cursor),
      // don't use this reactive implementation of #each.
      if (!(arg && 'observe' in arg))
        return orig.call(this, arg, options);

      return Spark.list(
        arg,
        function (item) {
          return Spark.labelBranch(item._id || null, function () {
            var html = Spark.isolate(_.bind(options.fn, null, item));
            return Spark.setDataContext(item, html);
          });
        },
        function () {
          return options.inverse ?
            Spark.isolate(options.inverse) : '';
        }
      );
    };

    _.extend(Handlebars._default_helpers, {
      isolate: function (options) {
        var data = this;
        return Spark.isolate(function () {
          return options.fn(data);
        });
      },
      constant: function (options) {
        var data = this;
        return Spark.createLandmark({ constant: true }, function () {
          return options.fn(data);
        });
      }
    });
  };

  // map from landmark id, to the 'this' object for
  // create/render/destroy callbacks on templates
  var templateInstanceData = {};

  var templateObjFromLandmark = function (landmark) {
    var template = templateInstanceData[landmark.id] || (
      templateInstanceData[landmark.id] = {
        // set these once
        find: function (selector) {
          if (! landmark.hasDom())
            throw new Error("Template not in DOM");
          return landmark.find(selector);
        },
        findAll: function (selector) {
          if (! landmark.hasDom())
            throw new Error("Template not in DOM");
          return landmark.findAll(selector);
        }
      });
    // set these each time
    template.firstNode = landmark.hasDom() ? landmark.firstNode() : null;
    template.lastNode = landmark.hasDom() ? landmark.lastNode() : null;
    return template;
  };

  // XXX forms hooks into this to add "fields". should be a public
  // interface for that.
  Meteor._template_decl_methods = {
    // methods store data here (event map, etc.).  initialized per template.
    _tmpl_data: null,
    // these functions must be generic (i.e. use `this`)
    events: function (eventMap) {
      var events =
            (this._tmpl_data.events = (this._tmpl_data.events || {}));
      _.extend(events, eventMap);
    },
    preserve: function (preserveMap) {
      var preserves =
            (this._tmpl_data.preserves = (this._tmpl_data.preserves || []));
      preserves.push(preserveMap);
    },
    helpers: function (helperMap) {
      var helpers =
            (this._tmpl_data.helpers = (this._tmpl_data.helpers || {}));
      for(var h in helperMap)
        helpers[h] = helperMap[h];
    }
  };

  Meteor._def_template = function (name, raw_func) {
    Meteor._hook_handlebars();

    window.Template = window.Template || {};

    // Define the function assigned to Template.<name>.

    var partial = function (data) {
      var tmpl = name && Template[name] || {};
      var tmplData = tmpl._tmpl_data || {};

      var allOptions = {
        preserve: _.clone(tmplData.preserves || []),
        create: [
          function () {
            var template = templateObjFromLandmark(this);
            template.data = data;
            tmpl.create && tmpl.create.call(template);
          }
        ],
        render: [
          function () {
            var template = templateObjFromLandmark(this);
            template.data = data;
            tmpl.render && tmpl.render.call(template);
          }
        ],
        destroy: [
          function () {
            // template.data is already set from previous callbacks
            tmpl.destroy &&
              tmpl.destroy.call(templateObjFromLandmark(this));
            delete templateInstanceData[this.id];
          }
        ],
        enter: [],
        exit: [],
        deliverEvent: []
      };

      // Run any extensions
      _.each(landmarkOptionsHooks, function (hook) {
        var newOptions = hook(tmpl);
        for (option in newOptions)
          allOptions[option].push(newOptions[option]);
      });

      // Merge all provided preserve instructions
      var preserve = {};
      _.each(allOptions.preserve, function (p) {
        if (_.isArray(p))
          _.each(p, function (selector) {
            preserve[selector] = true;
          });
        else
          _.extend(preserve, p);
      });

      // Function to render the body of the template (everything
      // inside the landmark)
      var htmlFunc = function (landmark) {
        var html = Spark.isolate(function () {
          // XXX Forms needs to run a hook before and after raw_func
          // (and receive 'landmark')
          return raw_func(data, {
            helpers: _.extend({}, partial, tmplData.helpers || {}),
            partials: Meteor._partials,
            name: name
          });
        });

        // take an event map with `function (event, template)`
        // handlers and produce one with `function (event,
        // landmark)` handlers for Spark, by inserting logic to
        // create the template object.
        var wrapEventMap = function (oldEventMap) {
          var newEventMap = {};
          _.each(oldEventMap, function (handler, key) {
            newEventMap[key] = function (event, landmark) {
              var data = this;
              var template = templateObjFromLandmark(landmark);
              var deliver = function (data, event, template) {
                return handler.call(data, event, template);
              };

              // Let extensions modify/wrap the event
              _.each(allOptions.deliverEvent, function (hook) {
                var previous = deliver;
                deliver = function (data, event, template) {
                  return hook.call(this, previous, data, event, template);
                };
              });

              return deliver.call(landmark);
            };
          });
          return newEventMap;
        };

        // support old Template.foo.events = {...} format
        var events =
          (tmpl.events !== Meteor._template_decl_methods.events ?
           tmpl.events : tmplData.events);
        // events need to be inside the landmark, not outside, so
        // that when an event fires, you can retrieve the enclosing
        // landmark to get the template data
        if (tmpl.events)
          html = Spark.attachEvents(wrapEventMap(events), html);
        return html;
      };

      var callAll = function (what) {
        return function () {
          var self = this;
          _.each(allOptions[what], function (f) {
            f.call(self);
          });
        };
      };

      var html = Spark.createLandmark({
        create: callAll("create"),
        render: callAll("render"),
        destroy: callAll("destroy"),
        enter: callAll("enter"),
        exit: callAll("exit"),
        preserve: preserve
      }, htmlFunc);

      html = Spark.setDataContext(data, html);
      return html;
    };

    // XXX hack.. copy all of Handlebars' built in helpers over to
    // the partial. it would be better to hook helperMissing (or
    // something like that?) so that Template.foo is searched only
    // if it's not a built-in helper.
    _.extend(partial, Handlebars.helpers);


    if (name) {
      if (Template[name])
        throw new Error("There are multiple templates named '" + name +
                        "'. Each template needs a unique name.");

      Template[name] = partial;
      _.extend(partial, Meteor._template_decl_methods);
      partial._tmpl_data = {};

      Meteor._partials[name] = partial;
    }

    // useful for unnamed templates, like body
    return partial;
  };

})();
