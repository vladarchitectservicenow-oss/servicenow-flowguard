var FlowGuardCrossEnvValidator = Class.create();
FlowGuardCrossEnvValidator.prototype = {

    initialize: function() {
        this._checkTimeout = 10000; // 10-second HTTP timeout per environment
    },

    /**
     * Validate a flow against ALL configured remote environments.
     * Returns: {valid: bool, results: [{environment, valid, checks: [...]}]}
     *
     * This is called BEFORE migration starts — if any environment reports
     * valid:false, the migration is blocked.
     */
    validateAllEnvironments: function(sourceFlowId) {
        var result = {valid: true, results: []};
        var envGr = new GlideRecord('x_flowguard_environment');
        envGr.addQuery('active', true);
        envGr.orderBy('order');
        envGr.query();

        while (envGr.next()) {
            var envResult = this._validateSingleEnv(sourceFlowId, envGr);
            result.results.push(envResult);
            if (!envResult.valid) {
                result.valid = false;
            }
        }

        return result;
    },

    /**
     * Run all 7 checks against ONE remote environment.
     */
    _validateSingleEnv: function(sourceFlowId, envGr) {
        var envName = envGr.getValue('name');
        var envUrl = envGr.getValue('instance_url');
        var envUser = envGr.getValue('username');
        var envPass = envGr.getValue('password') || ''; // password2 field

        if (typeof envPass === 'object' && envPass.getDecryptedValue) {
            envPass = envPass.getDecryptedValue();
        }

        var envResult = {
            environment: envName,
            instance_url: envUrl,
            valid: true,
            checks: []
        };

        // ── Check 0: Connectivity ─────────────────────────────────────────
        var connCheck = this._checkConnectivity(envUrl, envUser, envPass);
        envResult.checks.push(connCheck);
        if (!connCheck.passed) {
            envResult.valid = false;
            return envResult; // Can't run further checks if unreachable
        }

        // ── Check 1: Subflow existence in target ──────────────────────────
        var existenceCheck = this._checkSubflowExistence(sourceFlowId, envUrl, envUser, envPass);
        envResult.checks.push(existenceCheck);

        // ── Check 2: Subflow version mismatch ─────────────────────────────
        var versionCheck = this._checkSubflowVersions(sourceFlowId, envUrl, envUser, envPass);
        envResult.checks.push(versionCheck);

        // ── Check 3: Action type snapshot mismatch ────────────────────────
        var snapshotCheck = this._checkActionSnapshots(sourceFlowId, envUrl, envUser, envPass);
        envResult.checks.push(snapshotCheck);

        // ── Check 4: Data pill signature mismatch ─────────────────────────
        var pillCheck = this._checkDataPillSchemas(sourceFlowId, envUrl, envUser, envPass);
        envResult.checks.push(pillCheck);

        // ── Check 5: Action deprecation in target ─────────────────────────
        var deprecationCheck = this._checkActionDeprecation(sourceFlowId, envUrl, envUser, envPass);
        envResult.checks.push(deprecationCheck);

        // Aggregate: any critical failure means invalid
        for (var c = 0; c < envResult.checks.length; c++) {
            if (!envResult.checks[c].passed && envResult.checks[c].severity === 'critical') {
                envResult.valid = false;
                break;
            }
        }

        return envResult;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 0: Connectivity
    // ══════════════════════════════════════════════════════════════════════

    _checkConnectivity: function(envUrl, envUser, envPass) {
        var check = {
            check: 'connectivity',
            severity: 'critical',
            passed: false,
            issues: []
        };

        try {
            var req = new sn_ws.RESTMessageV2();
            req.setEndpoint(envUrl + '/api/now/table/sys_hub_flow?sysparm_limit=1');
            req.setHttpMethod('GET');
            req.setBasicAuth(envUser, envPass);
            req.setRequestHeader('Accept', 'application/json');
            req.setHttpTimeout(this._checkTimeout);

            var resp = req.execute();
            var statusCode = resp.getStatusCode();

            if (statusCode === 200) {
                check.passed = true;
            } else if (statusCode === 401 || statusCode === 403) {
                check.issues.push({
                    message: 'Authentication failed for ' + envUrl + ' (HTTP ' + statusCode + ')',
                    actionable: true,
                    action: 'Verify username/password in Environment settings'
                });
            } else {
                check.issues.push({
                    message: envUrl + ' returned HTTP ' + statusCode,
                    actionable: true,
                    action: 'Verify instance URL and network connectivity'
                });
            }
        } catch (e) {
            check.issues.push({
                message: 'Cannot reach ' + envUrl + ': ' + e.message,
                actionable: true,
                action: 'Verify network connectivity and VPN'
            });
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 1: Subflow existence in target
    // ══════════════════════════════════════════════════════════════════════

    _checkSubflowExistence: function(sourceFlowId, envUrl, envUser, envPass) {
        var check = {
            check: 'subflow_existence',
            severity: 'critical',
            passed: true,
            issues: []
        };

        var subflows = this._getSubflowsFromSource(sourceFlowId);
        for (var i = 0; i < subflows.length; i++) {
            var exists = this._queryTargetFlow(subflows[i].sys_id, envUrl, envUser, envPass);
            if (!exists) {
                check.passed = false;
                check.issues.push({
                    subflow_sys_id: subflows[i].sys_id,
                    subflow_name: subflows[i].name,
                    message: 'Subflow "' + subflows[i].name + '" does not exist in target environment',
                    actionable: true,
                    action: 'Deploy subflow "' + subflows[i].name + '" to target before migrating this flow'
                });
            }
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 2: Subflow version mismatch (THE KEY CHECK)
    // ══════════════════════════════════════════════════════════════════════

    _checkSubflowVersions: function(sourceFlowId, envUrl, envUser, envPass) {
        var check = {
            check: 'subflow_versions',
            severity: 'critical',
            passed: true,
            issues: []
        };

        var subflows = this._getSubflowsFromSource(sourceFlowId);
        for (var i = 0; i < subflows.length; i++) {
            var targetVersion = this._getTargetFlowVersion(subflows[i].sys_id, envUrl, envUser, envPass);
            if (targetVersion === null) continue; // Non-existent — caught by existence check

            var sourceVersion = parseInt(subflows[i].version, 10) || 0;
            var tgtVersion = parseInt(targetVersion, 10) || 0;

            if (sourceVersion !== tgtVersion) {
                check.passed = false;
                check.issues.push({
                    subflow_name: subflows[i].name,
                    subflow_sys_id: subflows[i].sys_id,
                    source_version: String(sourceVersion),
                    target_version: String(tgtVersion),
                    message: 'Subflow "' + subflows[i].name + '" version mismatch: v' +
                             sourceVersion + ' in source, v' + tgtVersion + ' in target',
                    actionable: true,
                    action: sourceVersion > tgtVersion
                        ? 'Deploy subflow "' + subflows[i].name + '" v' + sourceVersion + ' to target first'
                        : 'Target has newer version (v' + tgtVersion + '). Review before overwriting.'
                });
            }
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 3: Action type snapshot mismatch
    // ══════════════════════════════════════════════════════════════════════

    _checkActionSnapshots: function(sourceFlowId, envUrl, envUser, envPass) {
        var check = {
            check: 'action_snapshots',
            severity: 'critical',
            passed: true,
            issues: []
        };

        var actions = this._getFlowActions(sourceFlowId);
        for (var i = 0; i < actions.length; i++) {
            if (!actions[i].action_type_id) continue;

            var sourceSnapshot = this._getSnapshotVersion(actions[i].action_type_id);
            if (!sourceSnapshot) continue;

            var targetSnapshot = this._getTargetSnapshotVersion(
                actions[i].action_type_id, envUrl, envUser, envPass
            );

            if (targetSnapshot === null) {
                check.passed = false;
                check.issues.push({
                    action_name: actions[i].name || 'unnamed',
                    action_type_id: actions[i].action_type_id,
                    message: 'Action type "' + (actions[i].name || actions[i].action_type_id) +
                             '" not found in target — spoke may be missing',
                    actionable: true,
                    action: 'Install the required spoke in target environment'
                });
            } else if (sourceSnapshot !== targetSnapshot) {
                check.passed = false;
                check.issues.push({
                    action_name: actions[i].name || 'unnamed',
                    source_snapshot: sourceSnapshot,
                    target_snapshot: targetSnapshot,
                    message: 'Action "' + (actions[i].name || actions[i].action_type_id) +
                             '" snapshot differs: source=' + sourceSnapshot +
                             ', target=' + targetSnapshot,
                    actionable: true,
                    action: 'Update spoke in target to match source version'
                });
            }
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 4: Data pill signature mismatch
    // ══════════════════════════════════════════════════════════════════════

    _checkDataPillSchemas: function(sourceFlowId, envUrl, envUser, envPass) {
        var check = {
            check: 'data_pill_schemas',
            severity: 'critical',
            passed: true,
            issues: []
        };

        // Build source action input/output signature map
        var sourceActions = this._getFlowActions(sourceFlowId);
        var sourceSignatures = this._buildSignatureMap(sourceActions);

        // Query target flow to compare
        var subflows = this._getSubflowsFromSource(sourceFlowId);
        for (var i = 0; i < subflows.length; i++) {
            var targetActions = this._getTargetFlowActions(
                subflows[i].sys_id, envUrl, envUser, envPass
            );
            if (!targetActions || targetActions.length === 0) continue;

            var targetSignatures = this._buildSignatureMap(targetActions);

            // Compare signatures
            var keys = Object.keys(sourceSignatures);
            for (var k = 0; k < keys.length; k++) {
                var stepName = keys[k];
                var srcSig = sourceSignatures[stepName];
                var tgtSig = targetSignatures[stepName];

                if (!tgtSig) continue; // Step doesn't exist in target — caught elsewhere

                // Check for missing inputs
                for (var inp = 0; inp < srcSig.inputs.length; inp++) {
                    if (tgtSig.inputs.indexOf(srcSig.inputs[inp]) === -1) {
                        check.passed = false;
                        check.issues.push({
                            step: stepName,
                            missing_input: srcSig.inputs[inp],
                            message: 'Input "' + srcSig.inputs[inp] + '" in step "' +
                                     stepName + '" is missing in target environment',
                            actionable: true,
                            action: 'Update subflow "' + subflows[i].name +
                                    '" in target to include input "' + srcSig.inputs[inp] + '"'
                        });
                    }
                }

                // Check for missing outputs (data pills other steps depend on)
                for (var out = 0; out < srcSig.outputs.length; out++) {
                    if (tgtSig.outputs.indexOf(srcSig.outputs[out]) === -1) {
                        check.passed = false;
                        check.issues.push({
                            step: stepName,
                            missing_output: srcSig.outputs[out],
                            message: 'Output pill "' + srcSig.outputs[out] + '" from step "' +
                                     stepName + '" is missing in target — downstream steps will fail',
                            actionable: true,
                            action: 'Update subflow "' + subflows[i].name +
                                    '" in target to produce output "' + srcSig.outputs[out] + '"'
                        });
                    }
                }
            }
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHECK 5: Action deprecation in target
    // ══════════════════════════════════════════════════════════════════════

    _checkActionDeprecation: function(sourceFlowId, envUrl, envUser, envPass) {
        var check = {
            check: 'action_deprecation',
            severity: 'warning',
            passed: true,
            issues: []
        };

        // ServiceNow sometimes deprecates action types between releases.
        // We check if any action used in source has been deprecated in target.
        var actions = this._getFlowActions(sourceFlowId);
        for (var i = 0; i < actions.length; i++) {
            if (!actions[i].action_type_id) continue;

            try {
                var req = new sn_ws.RESTMessageV2();
                req.setEndpoint(
                    envUrl + '/api/now/table/sys_hub_action_type_snapshot/' +
                    actions[i].action_type_id + '?sysparm_fields=active'
                );
                req.setHttpMethod('GET');
                req.setBasicAuth(envUser, envPass);
                req.setRequestHeader('Accept', 'application/json');
                req.setHttpTimeout(this._checkTimeout);

                var resp = req.execute();
                if (resp.getStatusCode() === 200) {
                    var body = JSON.parse(resp.getBody());
                    var rec = body.result;
                    if (rec && rec.active === 'false') {
                        check.passed = false;
                        check.issues.push({
                            action_name: actions[i].name || 'unnamed',
                            message: 'Action "' + (actions[i].name || actions[i].action_type_id) +
                                     '" is deprecated/inactive in target environment',
                            actionable: true,
                            action: 'Replace deprecated action or install updated spoke'
                        });
                    }
                }
            } catch (e) {
                // Deprecation check is non-critical — skip on error
                gs.info('FlowGuard: Deprecation check skipped for ' +
                        actions[i].action_type_id + ': ' + e.message);
            }
        }

        return check;
    },

    // ══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Extract subflow references from the source flow.
     */
    _getSubflowsFromSource: function(sourceFlowId) {
        var subflows = [];
        var flowGr = new GlideRecord('sys_hub_flow');
        if (!flowGr.get(sourceFlowId)) return subflows;

        var model = flowGr.getValue('model');
        if (!model) return subflows;

        try {
            var parsed = JSON.parse(model);
            var actions = parsed.actions || parsed.stages || [];

            var seen = {};
            for (var i = 0; i < actions.length; i++) {
                if (actions[i].flow_sys_id) {
                    var id = actions[i].flow_sys_id;
                    if (!seen[id]) {
                        seen[id] = true;
                        var subGr = new GlideRecord('sys_hub_flow');
                        subflows.push({
                            sys_id: id,
                            name: subGr.get(id) ? subGr.getValue('name') : id,
                            version: subGr.get(id) ? subGr.getValue('version') : '0'
                        });
                    }
                }
            }
        } catch (e) {
            gs.error('FlowGuard: Failed to parse flow model: ' + e.message);
        }

        return subflows;
    },

    /**
     * Get action list from source flow.
     */
    _getFlowActions: function(sourceFlowId) {
        var flowGr = new GlideRecord('sys_hub_flow');
        if (!flowGr.get(sourceFlowId)) return [];

        var model = flowGr.getValue('model');
        if (!model) return [];

        try {
            var parsed = JSON.parse(model);
            return parsed.actions || parsed.stages || [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Query target instance: does flow with this sys_id exist?
     */
    _queryTargetFlow: function(sysId, envUrl, envUser, envPass) {
        try {
            var req = new sn_ws.RESTMessageV2();
            req.setEndpoint(envUrl + '/api/now/table/sys_hub_flow/' + sysId +
                           '?sysparm_fields=sys_id');
            req.setHttpMethod('GET');
            req.setBasicAuth(envUser, envPass);
            req.setRequestHeader('Accept', 'application/json');
            req.setHttpTimeout(this._checkTimeout);

            var resp = req.execute();
            return resp.getStatusCode() === 200;
        } catch (e) {
            return false;
        }
    },

    /**
     * Query target instance: get version of a specific flow.
     */
    _getTargetFlowVersion: function(sysId, envUrl, envUser, envPass) {
        try {
            var req = new sn_ws.RESTMessageV2();
            req.setEndpoint(envUrl + '/api/now/table/sys_hub_flow/' + sysId +
                           '?sysparm_fields=version');
            req.setHttpMethod('GET');
            req.setBasicAuth(envUser, envPass);
            req.setRequestHeader('Accept', 'application/json');
            req.setHttpTimeout(this._checkTimeout);

            var resp = req.execute();
            if (resp.getStatusCode() !== 200) return null;

            var body = JSON.parse(resp.getBody());
            return (body.result && body.result.version) ? body.result.version : '0';
        } catch (e) {
            return null;
        }
    },

    /**
     * Get action type snapshot version from local instance.
     */
    _getSnapshotVersion: function(actionTypeId) {
        var snapGr = new GlideRecord('sys_hub_action_type_snapshot');
        if (!snapGr.get(actionTypeId)) return null;
        return snapGr.getValue('version') || snapGr.getValue('sys_id');
    },

    /**
     * Get action type snapshot version from target instance.
     */
    _getTargetSnapshotVersion: function(actionTypeId, envUrl, envUser, envPass) {
        try {
            var req = new sn_ws.RESTMessageV2();
            req.setEndpoint(envUrl + '/api/now/table/sys_hub_action_type_snapshot/' +
                           actionTypeId + '?sysparm_fields=version,sys_id');
            req.setHttpMethod('GET');
            req.setBasicAuth(envUser, envPass);
            req.setRequestHeader('Accept', 'application/json');
            req.setHttpTimeout(this._checkTimeout);

            var resp = req.execute();
            if (resp.getStatusCode() !== 200) return null;

            var body = JSON.parse(resp.getBody());
            return (body.result && (body.result.version || body.result.sys_id))
                ? (body.result.version || body.result.sys_id) : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Get action list from a target flow.
     */
    _getTargetFlowActions: function(sysId, envUrl, envUser, envPass) {
        try {
            var req = new sn_ws.RESTMessageV2();
            req.setEndpoint(envUrl + '/api/now/table/sys_hub_flow/' + sysId +
                           '?sysparm_fields=model');
            req.setHttpMethod('GET');
            req.setBasicAuth(envUser, envPass);
            req.setRequestHeader('Accept', 'application/json');
            req.setHttpTimeout(this._checkTimeout);

            var resp = req.execute();
            if (resp.getStatusCode() !== 200) return [];

            var body = JSON.parse(resp.getBody());
            var model = (body.result && body.result.model) ? body.result.model : null;
            if (!model) return [];

            var parsed = JSON.parse(model);
            return parsed.actions || parsed.stages || [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Build a signature map: {stepName: {inputs: [...], outputs: [...]}}
     */
    _buildSignatureMap: function(actions) {
        var map = {};
        for (var i = 0; i < actions.length; i++) {
            var name = actions[i].name || 'step_' + i;
            var inputs = [];
            var outputs = [];

            // Extract input names
            if (actions[i].inputs) {
                inputs = Object.keys(actions[i].inputs);
            }

            // Extract output names (data pills produced by this step)
            if (actions[i].outputs) {
                outputs = Object.keys(actions[i].outputs);
            }

            map[name] = {inputs: inputs, outputs: outputs};
        }
        return map;
    },

    type: 'FlowGuardCrossEnvValidator'
};
