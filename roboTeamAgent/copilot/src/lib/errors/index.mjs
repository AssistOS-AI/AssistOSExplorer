/**
 * Centralized error exports for achilles-cli.
 *
 * Usage:
 *   import { SkillNotFoundError, GitOperationError } from './lib/errors/index.mjs';
 *
 * Error hierarchy:
 *   BaseError
 *   ├── ConfigurationError
 *   │   ├── RepositoryConfigurationError
 *   │   ├── EnvironmentConfigurationError
 *   │   └── ConfigFileError
 *   ├── OperationError
 *   │   ├── GitOperationError
 *   │   ├── SkillExecutionError
 *   │   │   └── SkillExecutionCancelledError
 *   │   ├── TestExecutionError
 *   │   └── FileSystemError
 *   ├── ValidationError
 *   │   ├── SchemaValidationError
 *   │   ├── FieldValidationError
 *   │   ├── InputValidationError
 *   │   └── RequiredFieldError
 *   └── ResourceError
 *       ├── SkillNotFoundError
 *       ├── RepositoryNotFoundError
 *       ├── FileNotFoundError
 *       ├── DirectoryNotFoundError
 *       └── ResourceAccessError
 */

// Base
export { BaseError } from './BaseError.mjs';

// Configuration errors
export {
    ConfigurationError,
    RepositoryConfigurationError,
    EnvironmentConfigurationError,
    ConfigFileError,
} from './ConfigurationError.mjs';

// Operation errors
export {
    OperationError,
    GitOperationError,
    SkillExecutionError,
    SkillExecutionCancelledError,
    TestExecutionError,
    FileSystemError,
} from './OperationError.mjs';

// Validation errors
export {
    ValidationError,
    SchemaValidationError,
    FieldValidationError,
    InputValidationError,
    RequiredFieldError,
} from './ValidationError.mjs';

// Resource errors
export {
    ResourceError,
    SkillNotFoundError,
    RepositoryNotFoundError,
    FileNotFoundError,
    DirectoryNotFoundError,
    ResourceAccessError,
} from './ResourceError.mjs';
