import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isValidHcashAddress } from '../../network/hcash-network';
import { getActiveChainProfile } from '../../network/chain-profile';


@ValidatorConstraint({ name: 'bitcoinAddress', async: false })
@Injectable()
export class BitcoinAddressValidator implements ValidatorConstraintInterface {

    constructor(
        private configService: ConfigService
    ) { }

    validate(value: string): boolean {
        // NETWORK remains configurable for compatibility, but validation is HCASH-only.
        this.configService.get('NETWORK');
        return isValidHcashAddress(value);
    }

    defaultMessage(): string {
        return `Must be a ${getActiveChainProfile().ticker} address`;
    }
}

export function IsBitcoinAddress(validationOptions?: ValidationOptions) {
    return function (object: Object, propertyName: string) {
        registerDecorator({
            name: 'isBitcoinAddress',
            target: object.constructor,
            propertyName: propertyName,
            constraints: [],
            options: validationOptions,
            validator: BitcoinAddressValidator,
        });
    };
}
