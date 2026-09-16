/**
 * Environment variable loader
 * Handles loading and validating environment variables
 */
class EnvironmentLoader {
    /**
     * Get environment variable with type conversion
     * @param {string} name - Environment variable name
     * @param {*} defaultValue - Default value if not set
     * @param {Function} converter - Converter function
     * @returns {*} The environment variable value
     */
    static get<D>(name: string, defaultValue: D): string | D;
    static get<D, R>(name: string, defaultValue: D, converter: (value: string) => R): R | D;
    static get(name: string, defaultValue: unknown, converter: ((value: string) => unknown) | null = null) {
      const value = process.env[name];
      
      if (value === undefined) {
        return defaultValue;
      }
      
      if (converter) {
        try {
          return converter(value);
        } catch (error) {
          throw new Error(`Invalid format for environment variable ${name}: ${error.message}`);
        }
      }
      
      return value;
    }
    
    /**
     * Get environment variable as string
     */
    static getString(name: string, defaultValue: string = ''): string {
      return this.get(name, defaultValue);
    }
    
    /**
     * Get environment variable as a secret
     * Checks if <name>_FILE is defined and reads the contents from the file
     * @param {string} name - Environment variable name
     * @param {string} defaultValue - Default value if not set
     * @returns {string} The secret value or default value
     */
    static getSecret(name: string, defaultValue: string = ''): string {
      const fileVarName = `${name}_FILE`;
      const filePath = process.env[fileVarName];

      if (filePath) {
        try {
          const fs: typeof import('fs') = require('fs');
          if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
          } else {
            throw new Error(`Secret file not found at path: ${filePath}`);
          }
        } catch (error) {
          throw new Error(`Error reading secret file for ${name}: ${error.message}`);
        }
      }

      return this.get(name, defaultValue);
    }
    
    /**
     * Get environment variable as integer
     */
    static getInt(name: string, defaultValue: number = 0): number {
      return this.get(name, defaultValue, (value) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          throw new Error(`Expected an integer`);
        }
        return parsed;
      });
    }
    
    /**
     * Get environment variable as boolean
     */
    static getBool(name: string, defaultValue: boolean = false): boolean {
      return this.get(name, defaultValue, (value) => {
        return value !== 'false';
      });
    }
    
    /**
     * Get required environment variable
     * @throws {Error} If the variable is not set
     */
    static getRequired(name: string): string {
      const value = process.env[name];
      
      if (value === undefined) {
        throw new Error(`Required environment variable ${name} is not set`);
      }
      
      return value;
    }
  }
  
  export default EnvironmentLoader;