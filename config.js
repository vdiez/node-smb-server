let config = {listen: {}};

config.listen.port = 8445;
config.listen.host = "0.0.0.0";

config.domainName = "WORKGROUP";
config.allowAnonymous = false;
config.smb2Support = false;
config.extendedSecurity = true;

config.db_host = 'localhost';
config.db_port = 27017;
config.db_name = 'workflow_engine';
config.db_storages = "storages";

config.shares = {
    'MEDIA': {
        "backend": "virutal_fs",
        "description": "virtual_fs",
        "path": "/"
    }
}
module.exports = config;