const yaml = require('js-yaml');
const fs = require('fs');
const path = require("path");
const formatter = require('esformatter');
const { models: default_models, domain: default_domain, type: default_type, app: default_app, service: default_service} = require('./defaults/config');

class Config {
    constructor(config) {
        this._config = {
            app: config.app || default_app,
            service: config.service || default_service,
            type: config.type || default_type,
            domain: config.domain || default_domain,
            custom: config.custom,
            models: config.models || default_models
        };
    }

    get app() {
        const {app} = this._config;
        return app;
    }

    set app(app) {
        this._config.app = app;
    }

    get service() {
        const {service} = this._config;
        return service;
    }

    set service(service) {
        this._config.service = service;
    }

    get type() {
        const {type} = this._config;
        return type;
    }

    set type(type) {
        this._config.type = type;
    }

    get custom() {
        const {custom} = this._config;
        return custom;
    }

    set custom(custom) {
        this._config.custom = custom;
    }

    get models() {
        const {models} = this._config;
        return models;
    }

    set models(models) {
        this._config.models = models;
    }

    UcFirst(string) 
    {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    underscoreToAllCaps(string) {
        return this.UcFirst(string.replace(/([-_][a-z])/ig, ($1) => {
            return $1.toUpperCase()
              .replace('-', '')
              .replace('_', '');
          }));
    }

    async create_directory(path) {
        if (!fs.existsSync(path)){
            fs.mkdirSync(path);
        }
    }

    async serverless_file() {
        let doc = yaml.safeLoad(fs.readFileSync(`${path.join(__dirname, '..')}/templates/serverless.yml`, 'utf8'));
        doc.app = this._config.app;
        doc.service = this._config.service;
        if (this._config.custom) doc.custom = this._config.custom;
        this.build_directories();
        await this.build_dynamo_db();
        await this.resources();
        await this.controller();
        await this.build_router();
        await this.factories();
        await this.validator();
        await this.logics();
        await this.models();
        await this.validator();
        await this.open_api();
        await this.package_json();

        doc.resources = [];
        doc.resources.push('${file(./aws/resources/dynamodb.yml)}');
        console.log('logging doc', doc);
        return fs.writeFile('./serverless.yml', yaml.safeDump(doc), (err) => {
            if (err) {
                console.log(err);
            }
            
            Promise.resolve(true);
        });
    }

    async build_directories() {
        const paths = [
            'application',
            'application/v1',
            'application/v1/controller',
            'application/v1/controller/apigateway',
            'application/v1/logic',
            'application/v1/logic/factories',
            'application/v1/model',
            'aws',
            'aws/envs',
            'aws/iamroles',
            'aws/resources'
        ]

        paths.forEach(path => this.create_directory(path))
        // application / v1 / controller
        // application / v1 / controller / apigateway
        // application / v1 / logic
        // application / v1 / logic / factories
        // application / v1 / model
        // aws / envs
        // aws / iamroles
        // aws / resources
    }

    async build_dynamo_db() {
        const { models } = this._config;

        const final = {
            Resources: {}
        }
        for (const [key, value] of Object.entries(models)) {
            const { ddb_config, gets } = value;
            // ddb_config - optional, if none supplied, just make gsi based off of key-id, we will make that the primary key.
            // ddb_config . range - optional the name of the resource (so use the id of that resource)
            // gets - optional array of properties supplied by user to make gsi's
            const resource = {
                Type: 'AWS::DynamoDB::Table',
                Properties: {
                    TableName: `\${self:provider.stackTags.name}-${key}`,
                    BillingMode: 'PAY_PER_REQUEST',
                    StreamSpecification: {
                        StreamViewType: 'NEW_AND_OLD_IMAGES'
                    },
                    PointInTimeRecoverySpecification: {
                        PointInTimeRecoveryEnabled: true
                    },
                    AttributeDefinitions: [{
                        AttributeName: `${key}_id`,
                        AttributeType: 'S'
                    }],
                    KeySchema: [{
                        AttributeName:  `${key}_id`,
                        KeyType: 'HASH'
                    }],
                    GlobalSecondaryIndexes: [
                        {
                            IndexName: `${key}_id`,
                            KeySchema: [
                                {
                                    AttributeName: `${key}_id`,
                                    KeyType: 'HASH'
                                }
                            ],
                            Projection: {
                                ProjectionType: 'ALL'
                            }
                        }
                    ]
                }
            }

            if(gets) {
                gets.forEach(getter => {
                    resource.Properties.AttributeDefinitions.push({
                        AttributeName: getter,
                        AttributeType: 'S'
                    });

                    resource.Properties.GlobalSecondaryIndexes.push( {
                        IndexName: `${getter}`,
                        KeySchema: [
                            {
                                AttributeName: `${getter}`,
                                KeyType: 'HASH'
                            }
                        ],
                        Projection: {
                            ProjectionType: 'ALL'
                        }
                    });
                })
            }

            if(ddb_config && ddb_config.range) {
                const find_key_name_range = models[ddb_config.range];
                if(find_key_name_range) {
                    resource.Properties.AttributeDefinitions.push({
                        AttributeName:  `${ddb_config.range}_id`,
                        AttributeType: 'S'
                    });

                    resource.Properties.KeySchema.push({
                        AttributeName:  `${ddb_config.range}_id`,
                        KeyType: 'RANGE'
                    })

                    resource.Properties.GlobalSecondaryIndexes.push({
                        IndexName: `${ddb_config.range}_id`,
                        KeySchema: [
                            {
                                AttributeName: `${ddb_config.range}_id`,
                                KeyType: 'HASH'
                            }
                        ],
                        Projection: {
                            ProjectionType: 'ALL'
                        }
                    });
                }
            }

            final.Resources[this.UcFirst(key)] = resource;
          }

        return fs.writeFile('./aws/resources/dynamodb.yml', yaml.safeDump(final), (err) => {
            if (err) {
                console.log(err);
            }

            Promise.resolve(true);
        });
    }

    async build_router() {
        const code_template = `const {Router} = require('syngenta-lambda-client').apigateway;

        exports.route = (event) => {
            const router = new Router({
                event,
                app: process.env.APP_NAME,
                service: process.env.SERVICE,
                version: 'v1',
                handlerPath: 'application/v1/controller/apigateway'
            });
            return router.route();
        };`

        const formatted = formatter.format(code_template);
            
        fs.writeFileSync(`./application/v1/controller/apigateway/_router.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
            if (err) {
                return console.log(err);
            }
            console.log("The file was saved!");
        });

    }

    async resources() {
        // apigateway
        const final = {
            Resources: {}
        }

        const apigateway_stage = {
            ApiGatewayStage: {
            Type: "AWS::ApiGateway::Stage",
            Properties: {
               StageName: "${self:provider.stage}",
               DeploymentId: {
                  Ref: "__deployment__"
               },
               RestApiId: {
                  Ref: "ApiGatewayRestApi"
               },
               MethodSettings: [
                  {
                     ResourcePath: "/*",
                     HttpMethod: "*",
                     LoggingLevel: "INFO",
                     DataTraceEnabled: true,
                     MetricsEnabled: true
                  }
               ]
            }
         }
        }

        const apigateway_base_path_mapping = 
        {
            ApiGatewayPublicBasePathMapping: {
                Type: "AWS::ApiGateway::BasePathMapping",
                Properties: {
                    BasePath: "${self:app}-${self:service}",
                    DomainName: this._config.domain,
                    RestApiId: {
                    Ref: "ApiGatewayRestApi"
                },
                Stage: {
                    Ref: "ApiGatewayStage"
                }
                }
            }
        }

        final.Resources['ApiGatewayStage'] = apigateway_stage;
        final.Resources['ApiGatewayPublicBasePathMapping'] = apigateway_base_path_mapping;

        return fs.writeFile('./aws/resources/apigateway.yml', yaml.safeDump(final), (err) => {
            if (err) {
                console.log(err);
            }

            Promise.resolve(true);
        });
    }

    async controller() {
        const { models } = this._config;
        for(let i = 0; i < Object.keys(models).length; i++) {
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, methods } = model;
            let code_template = `const validator = require('../../logic/validator');
            const ${this.UcFirst(key)} = require('../../logic/${key}');
            const ${key}Factory = require('../../logic/factories/${key}');

            exports.requirements = {
                post: {
                    requiredBody: 'v1-post-${key}-model'
                },
                patch: {
                    requiredBody: 'v1-patch-${key}-model'
                }
            };
            
            exports.get = async (request, response) => {
                if (validator.isValid${this.UcFirst(key)}Request(request, response)) {
                    if(request.params.${key}_id) {
                        const ${key} = await ${key}Factory.getById(request.params.${key}_id)
                        response.body = ${key}.export();
                    }`;

            for(const get of gets) {
                code_template += `else if(request.params.${get}) {
                    const ${key} = await ${key}Factory.getBy${this.underscoreToAllCaps(get)}(request.params.${get})
                    response.body = ${key}.export();
                }`
            }
            code_template += `}};`;
            for(const method of methods) {
                switch(method) {
                    case 'post':
                        code_template += `
                        
                        exports.post = async (request, response) => {
                            const ${key} = new ${this.UcFirst(key)}(request.body);
                            try {
                                response.body = await ${key}.create(request.authorizer['x-cognito-username']);
                            } catch (error) {
                                console.log(error);
                                response.code = 400;
                                response.setError('${key}_error', \`There was a problem creating your ${key}: \${error.message}\`);
                            }
                            return response;
                        };`;
                        break;
                    case 'patch':
                        code_template += `
                        
                        exports.patch = async (request, response) => {
                                if (await validator.${key}ExistsById(request, response)) {
                                    const ${key} = await ${key}Factory.getById(request.body.${key}_id);
                                    ${key}.merge(request.body);
                                    try {
                                        response.body = await ${key}.update(request.authorizer['x-cognito-username']);
                                    } catch (error) {
                                        console.log(error);
                                        response.code = 409;
                                        response.setError('data_conflict', \`Failed to update data: \${error.message}\`);
                                    }
                                }
                                return response;
                            };`;
                        break;
                    case 'delete':
                        code_template += `
                        
                        exports.delete = async (request, response) => {
                            if (await validator.${key}ExistsById(request, response)) {
                                await ${key}Factory.remove(request.params.${key}_id, request.authorizer['x-cognito-username']);
                                response.body = undefined;
                            }
                            return response;
                        };`;
                        break;
                    default:
                        break;
                }
            }
            const formatted = formatter.format(code_template);
            
            fs.writeFileSync(`./application/v1/controller/apigateway/${i === 0 ? 'index' : key}.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
                if (err) {
                    return console.log(err);
                }
                console.log("The file was saved!");
            });
        }

        Promise.resolve(true);
    }

    async factories() {
        const { models } = this._config;
        for(let i = 0; i < Object.keys(models).length; i++) {
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, ddb_config } = model;
            let code_template = `const ${key}Model = require('../../model/${key}');
            const ${this.UcFirst(key)} = require('../${key}');
            `;

            if(ddb_config && ddb_config.range) {
                code_template += `
                exports.getById = async (${key}_id, ${ddb_config.range}_id) => {
                    const result = await ${key}Model.getById(${key}_id, ${ddb_config.range}_id);
                    return new ${this.UcFirst(key)}(result);
                };
                `
            } else {
                code_template += `
                exports.getById = async (${key}_id) => {
                    const result = await ${key}Model.getById(${key}_id);
                    return new ${this.UcFirst(key)}(result);
                };
                `
            }

            for (const get of gets) {
                code_template += `
                exports.getBy${this.underscoreToAllCaps(get)} = async (${get}_id) => {
                    const result = await ${get}Model.getBy${this.underscoreToAllCaps(get)}(${get}_id);
                    return new ${this.UcFirst(get)}(result);
                };`
            }
            const formatted = formatter.format(code_template);
            
            fs.writeFileSync(`./application/v1/logic/factories/${key}.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
                if (err) {
                    return console.log(err);
                }
                console.log("The file was saved!");
            });
            
        }

        Promise.resolve(true);
    }

    async logics() {
        const { models } = this._config;
        for(let i = 0; i < Object.keys(models).length; i++) {
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, ddb_config } = model;
            let code_template = `const {v4: uuidv4} = require('uuid');
            const ${key}Model = require('../model/${key}');

            class ${this.UcFirst(key)} {
                constructor(${key}) {
                    this._${key} = {
                        ${key}_id: ${key}.${key}_id || uuidv4(),
            `;

            for(const get of gets) {
                code_template += `
                ${get}: ${key}.${get} || '',`
            }

            code_template += `
                    created: ${key}.created || new Date().toISOString(),
                    modified: ${key}.modified || new Date().toISOString()
                };
            }

            get ${key}_id() {
                return this._${key}.${key}_id;
            }
            `

            for(const get of gets) {
                code_template += `
                get ${get}() {
                    return this._${key}.${get};
                }
            
                set ${get}(${get}) {
                    this._${key}.${get} = ${get};
                }
                `
            }

            code_template += `

                get created() {
                    return this._company.created;
                }
            
                get modified() {
                    return this._company.modified;
                }

                export() {
                    return this._${key};
                }
            
                merge(new${this.UcFirst(key)}Obj) {
                    for (const property in this._${key}) {
                        if (new${this.UcFirst(key)}Obj[property]) {
                            this._${key}[property] = new${this.UcFirst(key)}Obj[property];
                        }
                    }
                }
            
                async create(author_id) {
                    const ${key} = await ${key}Model.create(this._${key}, author_id);
                    return ${key};
                }
            
                async update(author_id) {
                    const originalVersionKey = this._${key}.modified;
                    this._${key}.modified = new Date().toISOString();
                    const ${key} = await ${key}Model.update(this._${key}, originalVersionKey, author_id);
                    return ${key};
                }
            }

            module.exports = ${this.UcFirst(key)};`
            const formatted = formatter.format(code_template);
                
            fs.writeFileSync(`./application/v1/logic/${key}.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
                if (err) {
                    return console.log(err);
                }
                console.log("The file was saved!");
            });
        }
    }

    async models() {
        const { models } = this._config;
        for(let i = 0; i < Object.keys(models).length; i++) {
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, ddb_config } = model;
            let code_template = `const dataAdapter = require('syngenta-data-adapter');

            const _getAdapter = async (user_id = 'not-needed') => {
                const adapter = await dataAdapter.getAdapter({
                    engine: 'dynamodb',
                    endpoint: process.env.DYNAMODB_ENDPOINT,
                    region: process.env.AWS_REGION,
                    table: process.env.DYNAMODB_${key.toUpperCase()},
                    modelSchema: 'v1-${key}-model',
                    modelIdentifier: '${key}_id',
                    modelVersionKey: 'modified',
                    appIdentifier: process.env.APP_NAME,
                    authorIdentifier: user_id,
                    revisionArn: process.env.SNS_REVISION_RECORDS
                });
                return adapter;
            };

            exports.create = async (${key}, author_id) => {
                const adapter = await _getAdapter(author_id);
                const result = await adapter.insert({
                    data: ${key}
                });
                return result;
            };
            `;

            if(ddb_config && ddb_config.range) {
                code_template += `
                exports.update = async (${key}, originalVersionKey, author_id) => {
                    const adapter = await _getAdapter(author_id);
                    const result = await adapter.update({
                        data: ${key},
                        updateRetrieveOperation: 'get',
                        originalVersionKey,
                        query: {
                            Key: {
                                ${key}_id: ${key}.${key}_id,
                                ${ddb_config.range}_id: ${key}.${ddb_config.range}_id
                            }
                        }
                    });
                    return result;
                };
                
                exports.delete = async (${key}_id, ${ddb_config.range}_id, author_id) => {
                    const adapter = await _getAdapter(author_id);
                    const result = await adapter.delete({
                        query: {
                            Key: {
                                ${key}_id,
                                ${ddb_config.range}_id
                            }
                        }
                    });
                    return result;
                };

                exports.getAll = async (last_${key}_id = null, limit = 10) => {
                    const adapter = await _getAdapter();
                    const query = {
                        Limit: limit
                    };
                    if (last_${key}_id) {
                        query.ExclusiveStartKey = last_${key}_id;
                    }
                    const results = await adapter.scan({query});
                    return results;
                };
                
                exports.getById = async (${key}_id, ${ddb_config.range}_id) => {
                    const adapter = await _getAdapter();
                    const result = await adapter.get({
                        query: {
                            Key: {
                                ${key}_id,
                                ${ddb_config.range}_id
                            }
                        }
                    });
                    return result;
                };
                `
            } else {
                code_template += `
                exports.update = async (${key}, originalVersionKey, author_id) => {
                    const adapter = await _getAdapter(author_id);
                    const result = await adapter.update({
                        data: ${key},
                        updateRetrieveOperation: 'get',
                        originalVersionKey,
                        query: {
                            Key: {
                                ${key}_id: ${key}.${key}_id
                            }
                        }
                    });
                    return result;
                };
                
                exports.delete = async (${key}_id, author_id) => {
                    const adapter = await _getAdapter(author_id);
                    const result = await adapter.delete({
                        query: {
                            Key: {
                                ${key}_id
                            }
                        }
                    });
                    return result;
                };

                exports.getAll = async (last_${key}_id = null, limit = 10) => {
                    const adapter = await _getAdapter();
                    const query = {
                        Limit: limit
                    };
                    if (last_${key}_id) {
                        query.ExclusiveStartKey = last_${key}_id;
                    }
                    const results = await adapter.scan({query});
                    return results;
                };
                
                exports.getById = async (${key}_id) => {
                    const adapter = await _getAdapter();
                    const result = await adapter.get({
                        query: {
                            Key: {
                                ${key}_id
                            }
                        }
                    });
                    return result;
                };
                `
            }

            for (const get of gets) {
                code_template += `
                exports.getBy${this.underscoreToAllCaps(get)} = async (${get}) => {
                    const adapter = await _getAdapter('some-user-id');
                    const result = await adapter.query({
                        query: {
                            IndexName: '${get}',
                            Limit: 1,
                            KeyConditionExpression: \`${get} = :${get}\`,
                            ExpressionAttributeValues: {
                                ':${get}': ${get}
                            }
                        }
                    });
                    return result && result.length > 0 ? result[0] : null;
                };`
            }
            const formatted = formatter.format(code_template);
            
            fs.writeFileSync(`./application/v1/model/${key}.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
                if (err) {
                    return console.log(err);
                }
                console.log("The file was saved!");
            });
            
        }

        Promise.resolve(true);
    }

    async validator() {
        // for each keyExistsBy for each getter
        // is unique call isUniqueKey
        let code_template = '';
        const { models } = this._config;
        for(let i = 0; i < Object.keys(models).length; i++) {
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, ddb_config } = model;
            code_template += `const ${key}Model = require('../model/${key}');
            const ${key}Factory = require('./factories/${key}');
            `;
        }

        for(let i = 0; i < Object.keys(models).length; i++) {
            // get by id, figure out if range
            const key = Object.keys(models)[i];
            const model = Object.values(models)[i];
            const { gets, ddb_config } = model;



            if(ddb_config && ddb_config.range) {
                let valid_request_if_statements = `if(${key}_id && ${ddb_config.range}_id) found_valid_param.push('${key}_id;${ddb_config.range}_id');`;

                for (const get of gets) {
                    valid_request_if_statements += `
                    if(${get}) found_valid_param.push('${get}');`
                }

                code_template += `

                exports.isValid${this.UcFirst(key)}Request = async (request, response) => {
                    const {${gets.join(',')}} = request.params;
                    const found_valid_param = [];

                    ${valid_request_if_statements}

                    if (found_valid_param.length > 1) {
                        response.code = 403;
                        response.setError(
                            '${key}_id;${ddb_config.range}_id,${gets.join(',')}',
                            'only one get request parameter allowed for this request.'
                        );
                    }

                    return !response.hasErrors;
                };

                exports.isUnique${this.UcFirst(key)} = async (request, response) => {
                    const result = await ${key}Model.getById(request.body.${key}_id, request.body.${ddb_config.range}_id);
                    if (result && result.${key}_id) {
                        response.code = 400;
                        response.setError(
                            '${key}_id;${ddb_config.range}_id;',
                            \`${key} with ${key}_id \${request.body.${key}_id} and ${ddb_config.range}_id \${request.body.${ddb_config.range}_id} already exists.\`
                        );
                    }
                    return !response.hasErrors;
                };
                
                exports.${key}ExistsById = async (request, response) => {
                    const ${key}_id = request.params.${key}_id || request.body.${key}_id;
                    const ${key} = await ${key}Model.getById(${key}_id, request.params.${ddb_config.range}_id);
                    if (!${key}) {
                        response.code = 404;
                        response.setError('${key}', \`${key} with ${key}_id \${${key}_id} and ${ddb_config.range}_id \${request.params.${ddb_config.range}_id} does not exist\`);
                    }
                    return !response.hasErrors;
                }
                
                `
            } else {
                let valid_request_if_statements = `if(${key}_id) found_valid_param.push('${key}_id');
                `;

                for (const get of gets) {
                    valid_request_if_statements += `if(${get}) found_valid_param.push('${get}');
                    `
                }

                code_template += `

                exports.isValid${this.UcFirst(key)}Request = async (request, response) => {
                    const {${gets.join(',')}} = request.params;
                    const found_valid_param = [];

                    ${valid_request_if_statements}

                    if (found_valid_param.length > 1) {
                        response.code = 403;
                        response.setError(
                            '${key}_id,${gets.join(',')}',
                            'only one get request parameter allowed for this request.'
                        );
                    }

                    return !response.hasErrors;
                };

                exports.isUnique${this.UcFirst(key)} = async (request, response) => {
                    const result = await ${key}Model.getById(request.body.${key}_id);
                    if (result && result.${key}_id) {
                        response.code = 400;
                        response.setError(
                            '${key}_id',
                            \`${key} with ${key}_id \${request.body.${key}_id} already exists.\`
                        );
                    }
                    return !response.hasErrors;
                };
                
                exports.${key}ExistsById = async (request, response) => {
                    const ${key}_id = request.params.${key}_id || request.body.${key}_id;
                    const ${key} = await ${key}Model.getById(${key}_id);
                    if (!${key}) {
                        response.code = 404;
                        response.setError('${key}', \`${key} with ${key}_id \${${key}_id} does not exist\`);
                    }
                    return !response.hasErrors;
                }
                
                `
            }

            for (const get of gets) {
                code_template += `exports.${key}ExistsBy${this.UcFirst(get)} = async (request, response) => {
                    const ${key} = await ${key}Model.getBy${this.UcFirst(get)}(request.params.${get});
                    if (!${key}) {
                        response.code = 404;
                        response.setError('${get}', \`${key} with ${get} \${request.params.${get}} does not exist\`);
                    }
                    return !response.hasErrors;
                }
                
                `;
            }
        }

        const formatted = formatter.format(code_template);
        
        return fs.writeFileSync(`./application/v1/logic/validator.js`, formatted, {encoding:'utf8',flag:'w'}, function(err) {
            if (err) {
                return console.log(err);
            }
            console.log("The file was saved!");
            Promise.resolve(true);
        });

        
    }

    async package_json() {
        // const { models } = this._config;
        // for(let i = 0; i < Object.keys(models).length; i++) {
        //     const key = Object.keys(models)[i];
        //     const model = Object.values(models)[i];
        //     const { gets, ddb_config } = model;
        // }
        fs.copyFile(`${path.join(__dirname, '..')}/templates/npmrc.txt`, './.npmrc', (err) => {
            if (err) throw err;
            console.log('source.txt was copied to destination.txt');
          });
        const shell = require('shelljs')

        shell.exec(`${path.join(__dirname, '..')}/templates/package_json_setup.sh`);
        let _package = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        delete _package.scripts.test;
        _package.scripts.start = `concurrently \"serverless offline start --stage local --aws_envs local --region us-east-2\"`;
        fs.writeFileSync('./package.json', JSON.stringify(_package, null, 4))
        return true;
    }

    generate_component_model([key, value]) {
        const { gets, ddb_config } = value;
        let template = {
            [`v1-${key}-model`]: {
                title: `v1-${key}-model`,
                type: "object",
                properties: {
                    [`${key}_id`]: {
                        "minLength": 1,
                        "type": "string"
                    },
                    created: {
                        minLength: 1,
                        type: 'string',
                        format: 'date-time'
                    },
                    modified: {
                        minLength: 1,
                        type: 'string',
                        format: 'date-time'
                    }
                },
            },
            [`v1-post-${key}-request`]: {
                title: `v1-post-${key}-request`,
                allOf: [
                   {
                      "$ref": `#/components/schemas/v1-${key}-model`
                   },
                   {
                      required: [
                         `${key}_id`
                      ]
                   }
                ]
            },
            [`v1-${key}-response`]: {
                title: `v1-${key}-response`,
                allOf: [
                    {
                        "$ref": `#/components/schemas/v1-${key}-model`
                    },
                    {
                        required: []
                        // [
                        //     "field_id",
                        //     "external_reference_id",
                        //     "field_acres",
                        //     "field_name",
                        //     "field_boundary",
                        //     "farm_id",
                        //     "farm_name",
                        //     "grower_id",
                        //     "grower_salesforce_id",
                        //     "grower_name",
                        //     "created",
                        //     "modified"
                        // ]
                    }
                ]
            },
            [`v1-patch-${key}-request`]: {
                title: `v1-post-${key}-request`,
                "$ref": `#/components/schemas/v1-${key}-model`
             }
        }

        for(const get of gets) {
            template[`v1-${key}-model`].properties[get] = {
                "minLength": 1,
                "type": "string"
            }
        }

        if(ddb_config && ddb_config.range) {
            template[`v1-${key}-model`].properties[`${ddb_config.range}_id`] = {
                "minLength": 1,
                "type": "string"
            }

            template[`v1-post-${key}-request`].allOf[1].required.push(`${ddb_config.range}_id`);
        }

        return template;
    }

    generate_openapi_path(method, title) {        
        // generate_component_model = (key, models, gets, ddb_config)
        return {
            tags: [
                `${title}`
            ],
            operationId: `${this.UcFirst(method)}${this.UcFirst(title)}`,
            deprecated: false,
            summary: `${method === 'post' ? 'Post' : 'Update'} a ${title}`,
            description: 'body of the request',
            parameters: [
                {
                    '$ref': '#/x-custom/headers/x-app-id'
                },
                {
                    '$ref': '#/x-custom/headers/x-user-token'
                },
                {
                    '$ref': '#/x-custom/headers/x-api-key'
                }
            ],
            requestBody: {
                required: true,
                description: `${title} data`,
                content: {
                    'application/json': {
                        schema: {
                            '$ref': `#/components/schemas/v1-${method}-${title}-request`
                        }  
                    }
                }
            }  
        }
    }

    async open_api() {
        const { models } = this._config;
        const [main_model_key, main_model_value] = Object.entries(models)[0];
        delete models[Object.keys(models)[0]];
        const template = {
            openapi: "3.0.0",
            info: {
                title: `${this.UcFirst(main_model_key)} API`,
                version: "1.0.0",
                description: `${main_model_key} api`,
                contact: {
                    name: "Syngenta DPE USCO",
                    email: "syngenta.dpe.usco@gmail.com",
                    url: "https://developer.syngenta.com/"
                }
            },
            tags: [
                {
                    name: `${main_model_key}`,
                    description: `just an ${main_model_key} API`
                }
            ],
            servers: [
                {
                    url: `https://prod-api-enogen-sellers.syndpe.com/${main_model_key}`,
                    description: "PROD"
                },
                {
                    url: `https://uat-api-enogen-sellers.syndpe.com/${main_model_key}`,
                    description: "UAT"
                },
                {
                    url: `https://qa-api-enogen-sellers.syndpe.com/${main_model_key}`,
                    description: "QA"
                },
                {
                    url: `https://dev-api-enogen-sellers.syndpe.com/${main_model_key}`,
                    description: "DEV"
                }
            ],
            paths: {
                '/v1': {
                    post: null,
                    patch: null
                }
            },
            components: {
                schemas: {

                }
            },
            security: [
                {
                    'x-app-id': [],
                    'x-user-token': []
                },
                {
                    'x-api-key': []
                }
                ],
                'x-custom': {
                headers: {
                    ' x-app-id': {
                        name: "x-app-id",
                        in: "header",
                        required: true,
                        description: "the name of the app making the request",
                        schema: {
                            type: "string"
                        }
                    },
                    "x-user-token": {
                        name: "x-user-token",
                        in: "header",
                        required: false,
                        description: "public token for outside users (only must send thie or x-api-key)",
                        schema: {
                            type: "string"
                        }
                    },
                    "x-api-key": {
                        "name": "x-api-key",
                        in: "header",
                        required: false,
                        description: "an api key (only must send thie or x-user-token)",
                        schema: {
                            type: "string"
                        }
                    }
                }
                }
        }

        template.paths['/v1'].post = this.generate_openapi_path('post', main_model_key);
        template.paths['/v1'].patch = this.generate_openapi_path('patch', main_model_key);
        let components = this.generate_component_model([main_model_key, main_model_value]);

        for(const model in models) {
            const model_key = model;
            const model_value = models[model];
            console.log('logging model_key', model_key, 'logging model_value', model_value)
            template.paths[`/v1/${model_key}`] = {};
            template.paths[`/v1/${model_key}`].post = this.generate_openapi_path('post', model_key);
            template.paths[`/v1/${model_key}`].patch = this.generate_openapi_path('patch', model_key);
            const new_components = this.generate_component_model([model_key, model_value]);
            components = {...components, ...new_components}
        }

        template.components.schemas = components;

        return fs.writeFile('./openapi.yml', yaml.safeDump(template), (err) => {
            if (err) {
                console.log(err);
            }
            
            Promise.resolve(true);
        });    
    }

    async buildspec() {

    }

    async readme() {

    }

    export() {
        return this._config;
    }
}

module.exports = Config;
