export interface LocalStore {
  read(name:string):Promise<string|undefined>;
  write(name:string,value:string):Promise<void>;
}
